import type { EditPlan, Scene } from '../../shared/edit-plan.js';
import { SearchAssetsRequestSchema, type MediaAsset } from '../../shared/library.js';
import type { SceneCandidate, SceneCandidateResult } from '../../shared/scene-candidates.js';
import type { LibraryDatabase } from './database.js';
import { searchAssets } from './search.js';
import { sceneOffsets } from './scene-offsets.js';
import type { SemanticReranker } from './semantic.js';
import path from 'node:path';
import { sceneRange } from './scene-range.js';

const weakWords = new Set(['你好', '您好', '大家好', '嗨', '欢迎', '谢谢', '感谢', '再见', '好的', '是的', '我们', '你们', '他们', '今天', '现在']);

export function sceneSearchIntent(plan: EditPlan, scene: Scene, manualQuery = ''): Pick<SceneCandidateResult, 'query' | 'querySource'> {
  if (manualQuery.trim()) return { query: manualQuery.trim(), querySource: 'manual' };
  const strong = (words: string[]) => words.filter(word => !weakWords.has(word) && word.length > 1);
  const sceneWords = strong(scene.visual.intent.keywords);
  if (scene.visual.intent.planningSource === 'llm' && sceneWords.length) return { query: sceneWords.join(' ').slice(0, 500), querySource: 'scene' };
  const storyWords = [...new Set(strong([
    ...(plan.input.visualBrief ? plan.input.visualBrief.split(/[\s,，。;；]+/u) : []),
    ...plan.input.storyKeywords,
    ...plan.scenes.filter(item => item.id !== scene.id).flatMap(item => item.visual.intent.keywords)
  ]))].slice(0, 6);
  const words = [...new Set([...sceneWords, ...storyWords])].slice(0, 8);
  return words.length ? { query: words.join(' '), querySource: storyWords.length ? 'story' : 'scene' }
    : { query: '', querySource: 'none' };
}

function semanticSceneQuery(plan: EditPlan, scene: Scene, intent: Pick<SceneCandidateResult, 'query' | 'querySource'>): string {
  if (!intent.query || intent.querySource === 'manual') return intent.query;
  const parts = [plan.input.visualBrief && `画面方向：${plan.input.visualBrief}`,
    `整篇文案：${plan.input.script.slice(0, 600)}`, `当前分镜：${scene.script}`, `画面关键词：${intent.query}`];
  return parts.filter(Boolean).join('\n');
}

function usable(asset: MediaAsset, duration: number): boolean {
  return (asset.type === 'video' || asset.type === 'image') && asset.license.status !== 'unknown' &&
    (asset.type === 'image' || !!asset.durationMs && asset.durationMs >= duration);
}

export function isOriginalSourceAsset(plan: EditPlan, asset: MediaAsset): boolean {
  return asset.type === 'video' && !!plan.input.sourceVideoPath &&
    path.resolve(plan.input.sourceVideoPath) === path.resolve(asset.filePath);
}

function isCurrentVideo(plan: EditPlan, scene: Scene, asset: MediaAsset): boolean {
  return scene.visual.assetId === asset.id || (scene.visual.type === 'source' && isOriginalSourceAsset(plan, asset));
}

function overlapsCurrent(plan: EditPlan, scene: Scene, asset: MediaAsset, start: number, duration: number): boolean {
  if (!isCurrentVideo(plan, scene, asset)) return false;
  const currentStart = scene.visual.sourceInMs ?? 0;
  const currentEnd = scene.visual.sourceOutMs ?? currentStart + duration;
  return start < currentEnd && start + duration > currentStart;
}

function overlapsScene(scene: Scene, start: number, duration: number): boolean {
  const sceneStart = scene.visual.sourceInMs ?? 0;
  const sceneEnd = scene.visual.sourceOutMs ?? sceneStart + scene.endMs - scene.startMs;
  return start < sceneEnd && start + duration > sceneStart;
}

export async function listSceneCandidates(plan: EditPlan, sceneId: string, database: LibraryDatabase,
  options: { query?: string; throughSceneId?: string; ffmpegPath?: string; semantic?: SemanticReranker } = {}): Promise<SceneCandidateResult> {
  const { scenes: targets, durationMs: duration } = sceneRange(plan, sceneId, options.throughSceneId);
  const scene = targets[0];
  const initialIntent = sceneSearchIntent(plan, scene, options.query);
  const additional = options.query ? [] : targets.slice(1).flatMap(item => item.visual.intent.keywords);
  const intent = additional.length ? { ...initialIntent, query: [...new Set([initialIntent.query, ...additional].filter(Boolean))].join(' ').slice(0, 150) } : initialIntent;
  const ranked = intent.query ? searchAssets(database, SearchAssetsRequestSchema.parse({
    query: intent.query, types: ['video', 'image'], orientation: scene.visual.intent.orientation,
    minDurationMs: duration, limit: 100
  })).filter(item => usable(item.asset, duration)) : [];
  const relatedIds = new Set(ranked.map(item => item.asset.id));
  const inventory = database.list(10000).filter(asset => usable(asset, duration));
  let semanticScores = new Map<string, number>();
  let semanticError = false;
  if (intent.query && options.semantic) {
    try { semanticScores = await options.semantic.rank(semanticSceneQuery(plan, scene, intent), inventory); }
    catch { semanticError = true; }
  }
  const remaining = inventory.filter(asset => !relatedIds.has(asset.id));
  remaining.sort((left, right) => (semanticScores.get(right.id) ?? -1) - (semanticScores.get(left.id) ?? -1));
  const ordered = [...ranked.map(item => item.asset), ...remaining];
  const candidates: SceneCandidate[] = [];
  for (const asset of ordered.slice(0, 30)) {
    if (asset.type === 'image') {
      if (targets.length === 1 && scene.visual.assetId === asset.id) continue;
      candidates.push({ choice: { type: 'asset', assetId: asset.id, throughSceneId: options.throughSceneId }, asset,
        match: relatedIds.has(asset.id) ? 'related' : semanticScores.has(asset.id) ? 'semantic' : 'fill',
        reasons: relatedIds.has(asset.id) ? ['关键词匹配'] : semanticScores.has(asset.id) ? ['素材文字语义排序'] : ['按画幅与素材类型填充'] });
      continue;
    }
    const currentVideo = targets.some(target => isCurrentVideo(plan, target, asset));
    const starts = await sceneOffsets(asset, duration, currentVideo ? options.ffmpegPath : undefined);
    if (currentVideo) {
      const currentStart = scene.visual.sourceInMs ?? 0;
      const currentEnd = scene.visual.sourceOutMs ?? currentStart + duration;
      if (currentStart >= duration) starts.push(currentStart - duration);
      if (currentEnd + duration <= asset.durationMs!) starts.push(currentEnd);
    }
    const targetIds = new Set(targets.map(target => target.id));
    const otherScenes = plan.scenes.filter(item => !targetIds.has(item.id) && isCurrentVideo(plan, item, asset));
    const available = starts.filter(start =>
      (targets.length !== 1 || !overlapsCurrent(plan, scene, asset, start, duration)) &&
      !otherScenes.some(item => overlapsScene(item, start, duration)));
    available.sort((left, right) => left - right);
    for (const start of available.slice(0, currentVideo ? 4 : 2)) {
      candidates.push({ choice: { type: 'asset', assetId: asset.id, sourceInMs: start, throughSceneId: options.throughSceneId }, asset,
        sourceOutMs: start + duration, match: currentVideo ? 'alternate' : relatedIds.has(asset.id) ? 'related' : semanticScores.has(asset.id) ? 'semantic' : 'fill',
        reasons: [currentVideo ? '同一视频的其他时间段' : relatedIds.has(asset.id) ? '关键词匹配' : semanticScores.has(asset.id) ? '素材文字语义排序' : '按画幅与时长填充',
          asset.width && asset.height && (scene.visual.intent.orientation === 'landscape' ? asset.width > asset.height :
            scene.visual.intent.orientation === 'portrait' ? asset.height > asset.width : Math.abs(asset.width - asset.height) < asset.width * 0.15) ? '画幅接近' : '可能需要裁切'] });
    }
    if (candidates.length >= 24) break;
  }
  const notice = !candidates.length && inventory.length ? '素材虽在库中，但所需视频时间段已被其他镜头使用，或当前画面没有可替换的其他片段。'
    : intent.querySource === 'none' ? '这句没有明确的画面关键词，下面按素材条件推荐；填充画面不代表语义匹配。'
    : semanticError ? '本地语义模型暂不可用，已使用关键词和素材条件继续检索。'
      : !ranked.length && !semanticScores.size ? `本地素材没有与“${intent.query}”匹配的标签；仍可手动选填充画面。` : undefined;
  return { ...intent, onlineQuery: options.query?.trim() || scene.visual.intent.searchQuery || intent.query,
    candidates: candidates.slice(0, 24), notice };
}
