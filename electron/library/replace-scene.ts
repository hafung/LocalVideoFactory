import { EditPlanSchema, type EditPlan } from '../../shared/edit-plan.js';
import { SearchAssetsRequestSchema } from '../../shared/library.js';
import type { LibraryDatabase } from './database.js';
import type { SceneChoice } from '../../shared/scene-candidates.js';
import path from 'node:path';
import { searchAssets } from './search.js';
import { sceneRange } from './scene-range.js';
import { isOriginalSourceAsset } from './scene-candidates.js';

export class NoReplacementAssetError extends Error {
  constructor(message: string) { super(message); this.name = 'NoReplacementAssetError'; }
}

export function applySceneChoice(plan: EditPlan, sceneId: string, choice: SceneChoice, database: LibraryDatabase, now = new Date()): EditPlan {
  if (plan.status !== 'resolved') throw new Error('只有已生成预览的工程可以替换分镜素材');
  const { scenes: targets, durationMs: duration } = sceneRange(plan, sceneId, choice.throughSceneId);
  const scene = targets[0];
  const asset = choice.type === 'asset' ? database.byId(choice.assetId) : undefined;
  if (choice.type === 'asset') {
    if (!asset || !['video', 'image'].includes(asset.type)) throw new Error('所选画面已不在素材库中');
    if (asset.license.status === 'unknown') throw new Error('所选素材的授权状态未知');
    if (asset.type === 'video' && (!asset.durationMs || asset.durationMs < duration)) throw new Error('所选视频短于分镜时长');
    const start = choice.sourceInMs ?? 0;
    if (asset.type === 'image' && choice.sourceInMs !== undefined) throw new Error('图片不能设置视频入点');
    if (asset.type === 'video' && start + duration > asset.durationMs!) throw new Error('所选时间段超出视频时长');
    if (targets.length === 1 && (scene.visual.assetId === asset.id || (scene.visual.type === 'source' && !!plan.input.sourceVideoPath &&
      path.resolve(plan.input.sourceVideoPath) === path.resolve(asset.filePath)))) {
      if (asset.type === 'image') throw new Error('这张图片已是当前画面');
      const currentStart = scene.visual.sourceInMs ?? 0;
      const currentEnd = scene.visual.sourceOutMs ?? currentStart + duration;
      if (start < currentEnd && start + duration > currentStart) throw new Error('请选择与当前画面不重叠的视频时间段');
    }
    if (asset.type === 'video') {
      const selectedIds = new Set(targets.map(item => item.id));
      for (const other of plan.scenes) {
        if (selectedIds.has(other.id) || !(other.visual.assetId === asset.id ||
          (other.visual.type === 'source' && isOriginalSourceAsset(plan, asset)))) continue;
        const otherStart = other.visual.sourceInMs ?? 0;
        const otherEnd = other.visual.sourceOutMs ?? otherStart + other.endMs - other.startMs;
        if (start < otherEnd && start + duration > otherStart) throw new Error('所选视频片段已用于其他分镜，请选择未使用的时间段');
      }
    }
  }
  const targetIds = new Set(targets.map(item => item.id));
  const scenes = plan.scenes.map(item => !targetIds.has(item.id) ? item : ({
    ...item,
    visual: choice.type === 'kinetic-text' ? {
      ...item.visual, type: 'kinetic-text' as const, assetId: undefined, sourceInMs: undefined, sourceOutMs: undefined,
      sourceMatch: undefined,
      motion: 'slow-zoom-in' as const
    } : {
      ...item.visual, type: asset!.type as 'video' | 'image', assetId: asset!.id,
      sourceMatch: undefined,
      sourceInMs: asset!.type === 'video' ? (choice.sourceInMs ?? 0) + item.startMs - scene.startMs : undefined,
      sourceOutMs: asset!.type === 'video' ? (choice.sourceInMs ?? 0) + item.endMs - scene.startMs : undefined,
      motion: asset!.type === 'image' ? 'slow-zoom-in' as const : 'none' as const
    }
  }));
  return EditPlanSchema.parse({ ...plan, revision: plan.revision + 1, updatedAt: now.toISOString(), scenes });
}

export function replaceSceneAsset(plan: EditPlan, sceneId: string, database: LibraryDatabase, now = new Date()): EditPlan {
  if (plan.status !== 'resolved') throw new Error('只有 resolved 工程可以替换分镜素材');
  const sceneIndex = plan.scenes.findIndex(scene => scene.id === sceneId);
  if (sceneIndex < 0) throw new Error('找不到要替换的分镜');
  const scene = plan.scenes[sceneIndex];
  const keywords = scene.visual.intent.keywords.join(' ');
  const types = scene.visual.intent.preferredTypes.filter((type): type is 'video' | 'image' => type === 'video' || type === 'image');
  const avoided = new Set([...scene.visual.intent.avoidAssetIds, ...(scene.visual.assetId ? [scene.visual.assetId] : [])]);
  const duration = scene.endMs - scene.startMs;
  const candidates = searchAssets(database, SearchAssetsRequestSchema.parse({
    query: keywords, orientation: scene.visual.intent.orientation,
    types, avoidAssetIds: [...avoided],
    minDurationMs: scene.endMs - scene.startMs, limit: 20
  })).filter(candidate => !candidate.reasons.includes('重复惩罚') && !isOriginalSourceAsset(plan, candidate.asset) && candidate.asset.license.status !== 'unknown');
  const selected = candidates[0]?.asset;
  if (!selected) {
    const media = database.list(10000).filter(asset => asset.type !== 'audio' && types.includes(asset.type) && !isOriginalSourceAsset(plan, asset));
    const unused = media.filter(asset => !avoided.has(asset.id));
    const licensed = unused.filter(asset => asset.license.status !== 'unknown');
    const longEnough = licensed.filter(asset => asset.type === 'image' || !asset.durationMs || asset.durationMs >= duration);
    const message = !media.length ? '素材库中还没有可用于此分镜的视频或图片，请先导入素材。'
      : !unused.length ? '素材库里没有其他可换的画面：当前素材已使用或此前已排除。请再导入一个视频或图片。'
      : !licensed.length ? '其他素材的授权状态未知，请先使用可追踪授权的素材。'
      : !longEnough.length ? `其他视频都短于此分镜（${(duration / 1000).toFixed(1)} 秒），请导入更长的视频或图片。`
      : keywords ? `本地素材中没有与“${keywords}”匹配的其他画面。可添加相关标签或导入更多素材。`
        : '当前没有符合条件的其他画面，请检查素材类型和标签。';
    throw new NoReplacementAssetError(message);
  }
  const updatedScenes = plan.scenes.map((item, index) => index !== sceneIndex ? item : ({
    ...item,
    visual: {
      ...item.visual, type: selected.type as 'video' | 'image', assetId: selected.id,
      sourceMatch: undefined,
      sourceInMs: selected.type === 'video' ? 0 : undefined,
      sourceOutMs: selected.type === 'video' ? item.endMs - item.startMs : undefined,
      motion: selected.type === 'image' ? 'slow-zoom-in' as const : 'none' as const,
      intent: { ...item.visual.intent, avoidAssetIds: [...new Set([...item.visual.intent.avoidAssetIds, ...(item.visual.assetId ? [item.visual.assetId] : [])])] }
    }
  }));
  return EditPlanSchema.parse({ ...plan, revision: plan.revision + 1, updatedAt: now.toISOString(), scenes: updatedScenes });
}
