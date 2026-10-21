import { EditPlanSchema, type EditPlan, type Scene } from '../../shared/edit-plan.js';
import { SearchAssetsRequestSchema } from '../../shared/library.js';
import type { LibraryDatabase } from './database.js';
import { searchAssets } from './search.js';
import { sceneSearchIntent } from './scene-candidates.js';
import { isOriginalSourceAsset } from './scene-candidates.js';

export function selectBroll(plan: EditPlan, database: LibraryDatabase, now = new Date(), options: { avoidAssetIds?: string[]; videoOnly?: boolean } = {}): EditPlan {
  if (plan.status !== 'resolved') throw new Error('只有 resolved EditPlan 可以选择素材');
  const used = new Map<string, Array<{ start: number; end: number }>>();
  const remember = (id: string, start: number, end: number) => used.set(id, [...(used.get(id) ?? []), { start, end }]);
  for (const scene of plan.scenes) if (scene.visual.type !== 'kinetic-text' && scene.visual.assetId) {
    remember(scene.visual.assetId, scene.visual.sourceInMs ?? 0, scene.visual.sourceOutMs ?? (scene.visual.sourceInMs ?? 0) + scene.endMs - scene.startMs);
  }
  const freeStart = (id: string, duration: number, assetDuration?: number): number | undefined => {
    if (!assetDuration || assetDuration < duration) return undefined;
    let start = 0;
    for (const range of [...(used.get(id) ?? [])].sort((left, right) => left.start - right.start)) {
      if (start + duration <= range.start) return start;
      if (start < range.end) start = range.end;
    }
    return start + duration <= assetDuration ? start : undefined;
  };
  let changed = false;
  const scenes = [...plan.scenes];
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index];
    if (scene.visual.type !== 'kinetic-text') {
      continue;
    }
    const preferred = scene.visual.intent.preferredTypes.filter(type => type === 'video' || (!options.videoOnly && type === 'image'));
    if (!preferred.length) continue;
    let last = index;
    const groupWords = new Set(scene.visual.intent.keywords.filter(word => word.length > 1 && !['你好', '您好', '大家好'].includes(word)));
    while (last + 1 < scenes.length && last - index < 2) {
      const next = scenes[last + 1];
      const nextWords = next.visual.intent.keywords.filter(word => word.length > 1 && !['你好', '您好', '大家好'].includes(word));
      if (next.visual.type !== 'kinetic-text' || next.endMs - scene.startMs > 5000 ||
        scenes[last].endMs !== next.startMs ||
        (groupWords.size > 0 && nextWords.length > 0 && !nextWords.some(word => groupWords.has(word)))) break;
      last++;
      nextWords.forEach(word => groupWords.add(word));
    }
    let result: ReturnType<typeof searchAssets>[number] | undefined;
    let chosenLast = index;
    for (let end = last; end >= index; end--) {
      const duration = scenes[end].endMs - scene.startMs;
      const types = preferred.filter(type => type !== 'image' || duration <= 2000);
      if (!types.length) continue;
      const candidates = searchAssets(database, SearchAssetsRequestSchema.parse({
        query: sceneSearchIntent(plan, scene).query, orientation: scene.visual.intent.orientation,
        types, avoidAssetIds: scene.visual.intent.avoidAssetIds,
        minDurationMs: duration, limit: 100
      })).sort((left, right) => Number(left.asset.type === 'image') - Number(right.asset.type === 'image') ||
        (right.score - (options.avoidAssetIds?.includes(right.asset.id) ? 1.5 : 0) - (used.has(right.asset.id) ? 3 : 0)) -
        (left.score - (options.avoidAssetIds?.includes(left.asset.id) ? 1.5 : 0) - (used.has(left.asset.id) ? 3 : 0)))
        .filter(candidate => !isOriginalSourceAsset(plan, candidate.asset) && candidate.asset.license.status !== 'unknown' &&
        !scene.visual.intent.avoidAssetIds.includes(candidate.asset.id) &&
        (candidate.asset.type === 'image' ? !used.has(candidate.asset.id) :
          freeStart(candidate.asset.id, duration, candidate.asset.durationMs) !== undefined));
      result = candidates[0];
      if (result) { chosenLast = end; break; }
    }
    if (!result) continue;
    changed = true;
    const duration = scenes[chosenLast].endMs - scene.startMs;
    const sourceInMs = result.asset.type === 'video' ? freeStart(result.asset.id, duration, result.asset.durationMs)! : undefined;
    remember(result.asset.id, sourceInMs ?? 0, (sourceInMs ?? 0) + duration);
    for (let selected = index; selected <= chosenLast; selected++) {
      const item = scenes[selected];
      scenes[selected] = {
        ...item,
        visual: {
          ...item.visual, type: result.asset.type as 'video' | 'image', assetId: result.asset.id,
          sourceInMs: result.asset.type === 'video' ? sourceInMs! + item.startMs - scene.startMs : undefined,
          sourceOutMs: result.asset.type === 'video' ? sourceInMs! + item.endMs - scene.startMs : undefined,
          motion: result.asset.type === 'image' ? 'slow-zoom-in' as const : 'none' as const
        }
      };
    }
    index = chosenLast;
  }
  if (!changed) return plan;
  return EditPlanSchema.parse({ ...plan, revision: plan.revision + 1, updatedAt: now.toISOString(), scenes });
}

/** Last resort: short video clips or individual images may fill the remaining gaps. */
export function splitUnfilledScenes(plan: EditPlan): EditPlan {
  let changed = false;
  const scenes = plan.scenes.flatMap(scene => {
    const duration = scene.endMs - scene.startMs;
    if (scene.visual.type !== 'kinetic-text' || duration <= 2000) return [scene];
    changed = true;
    const count = Math.ceil(duration / 2000);
    return Array.from({ length: count }, (_, index) => {
      const startMs = scene.startMs + Math.round(duration * index / count);
      const endMs = scene.startMs + Math.round(duration * (index + 1) / count);
      return { ...scene, id: `${scene.id}-fill-${index + 1}`, originSceneId: scene.originSceneId ?? scene.id, startMs, endMs,
        visual: { ...scene.visual, intent: { ...scene.visual.intent, minDurationMs: endMs - startMs } } };
    });
  });
  return changed ? EditPlanSchema.parse({ ...plan, scenes, revision: plan.revision + 1, updatedAt: new Date().toISOString() }) : plan;
}

/** Use shorter local video takes before online fallback can fill a gap with still images. */
export function fillShortLocalVideos(plan: EditPlan, database: LibraryDatabase, options: { avoidAssetIds?: string[] } = {}): EditPlan {
  const used = new Map<string, Array<{ start: number; end: number }>>();
  const remember = (id: string, start: number, end: number) => used.set(id, [...(used.get(id) ?? []), { start, end }]);
  for (const scene of plan.scenes) if (scene.visual.assetId && scene.visual.type !== 'kinetic-text') {
    const start = scene.visual.sourceInMs ?? 0;
    remember(scene.visual.assetId, start, scene.visual.sourceOutMs ?? start + scene.endMs - scene.startMs);
  }
  const scenes: Scene[] = []; let changed = false;
  for (const scene of plan.scenes) {
    if (scene.visual.type !== 'kinetic-text') { scenes.push(scene); continue; }
    const candidates = searchAssets(database, SearchAssetsRequestSchema.parse({ query: sceneSearchIntent(plan, scene).query,
      orientation: scene.visual.intent.orientation, types: ['video'], avoidAssetIds: scene.visual.intent.avoidAssetIds,
      minDurationMs: 500, limit: 100 })).filter(({ asset }) => asset.durationMs && asset.license.status !== 'unknown' && !isOriginalSourceAsset(plan, asset));
    let cursor = scene.startMs; let piece = 0;
    while (cursor < scene.endMs) {
      const choices = candidates.flatMap(({ asset, score }) => {
        let start = 0; const free: Array<{ start: number; end: number }> = [];
        for (const range of [...(used.get(asset.id) ?? [])].sort((a, b) => a.start - b.start)) {
          if (range.start > start) free.push({ start, end: range.start }); start = Math.max(start, range.end);
        }
        if (start < asset.durationMs!) free.push({ start, end: asset.durationMs! });
        return free.map(range => ({ asset, start: range.start, length: Math.min(scene.endMs - cursor, range.end - range.start),
          score: score - (options.avoidAssetIds?.includes(asset.id) ? 1.5 : 0) - (used.has(asset.id) ? 3 : 0) }))
          .filter(choice => choice.length >= Math.min(1000, scene.endMs - cursor));
      }).sort((a, b) => b.score - a.score || b.length - a.length);
      const choice = choices[0]; if (!choice) break;
      scenes.push({ ...scene, id: `${scene.id}-local-${++piece}`, startMs: cursor, endMs: cursor + choice.length,
        originSceneId: scene.originSceneId ?? scene.id, visual: { ...scene.visual, type: 'video', assetId: choice.asset.id,
          sourceInMs: choice.start, sourceOutMs: choice.start + choice.length, motion: 'none', sourceMatch: undefined,
          intent: { ...scene.visual.intent, minDurationMs: choice.length } } });
      remember(choice.asset.id, choice.start, choice.start + choice.length); cursor += choice.length; changed = true;
    }
    if (cursor < scene.endMs) scenes.push({ ...scene, id: piece ? `${scene.id}-local-unfilled` : scene.id, startMs: cursor,
      visual: { ...scene.visual, intent: { ...scene.visual.intent, minDurationMs: scene.endMs - cursor } } });
  }
  return changed ? EditPlanSchema.parse({ ...plan, scenes, revision: plan.revision + 1, updatedAt: new Date().toISOString() }) : plan;
}
