import { EditPlanSchema, type EditPlan, type Scene } from '../../shared/edit-plan.js';
import type { OnlineMediaService } from './online/service.js';
import { englishSearchQuery } from '../../shared/keywords.js';

export type AutomaticMediaProvider = Pick<OnlineMediaService, 'acquire'>;

/** Exhaust video candidates before using images, each image held for at most two seconds. */
export async function fillOnlineMedia(plan: EditPlan, provider: AutomaticMediaProvider, signal: AbortSignal,
  progress: (fraction: number, message: string) => void, usedUrls: string[] = [],
  options: { types?: Array<'video' | 'image'> } = {}): Promise<EditPlan> {
  const used = new Set(usedUrls);
  const warnings = new Set(plan.warnings ?? []);
  const scenes: Scene[] = [];
  const targets = plan.scenes.filter(scene => scene.visual.type === 'kinetic-text').length;
  let processed = 0; let changed = false;
  for (const scene of plan.scenes) {
    if (scene.visual.type !== 'kinetic-text') { scenes.push(scene); continue; }
    signal.throwIfAborted();
    const query = scene.visual.intent.searchQuery || englishSearchQuery(scene.visual.intent.keywords.join(' '));
    if (!query.trim()) { scenes.push(scene); processed++; continue; }
    const pieces: Scene[] = [];
    let cursor = scene.startMs;
    for (const type of options.types ?? ['video', 'image'] as const) {
      if (cursor === scene.endMs) break;
      progress(processed / targets, `正在为分镜搜索${type === 'video' ? '视频' : '短时图片'}：${query}`);
      while (cursor < scene.endMs) {
        const { asset, notice } = await provider.acquire({ query, types: [type], orientation: scene.visual.intent.orientation,
          minDurationMs: type === 'video' ? 1000 : undefined }, scene.endMs - cursor, used, signal);
        signal.throwIfAborted();
        if (notice) warnings.add(`在线${type === 'video' ? '视频' : '图片'}补画面：${notice}`.slice(0, 500));
        if (!asset) break;
        const length = Math.min(scene.endMs - cursor, type === 'image' ? 2000 : asset.durationMs!);
        pieces.push({ ...scene, startMs: cursor, endMs: cursor + length,
          originSceneId: scene.originSceneId ?? scene.id,
          visual: { ...scene.visual, type, assetId: asset.id,
            sourceInMs: type === 'video' ? 0 : undefined, sourceOutMs: type === 'video' ? length : undefined,
            motion: type === 'image' ? 'slow-zoom-in' : 'none', intent: { ...scene.visual.intent, minDurationMs: length } } });
        cursor += length;
      }
    }
    changed ||= pieces.length > 0;
    for (const [index, piece] of pieces.entries()) scenes.push({ ...piece,
      id: pieces.length === 1 && cursor === scene.endMs ? scene.id : `${scene.id}-media-${index + 1}` });
    if (cursor < scene.endMs) scenes.push({ ...scene, id: pieces.length ? `${scene.id}-unfilled` : scene.id,
      startMs: cursor, visual: { ...scene.visual, intent: { ...scene.visual.intent, minDurationMs: scene.endMs - cursor } } });
    processed++;
    progress(processed / targets, `素材选择 ${processed}/${targets}`);
  }
  return changed || warnings.size !== (plan.warnings?.length ?? 0)
    ? EditPlanSchema.parse({ ...plan, scenes, warnings: [...warnings].slice(0, 30), revision: plan.revision + 1, updatedAt: new Date().toISOString() }) : plan;
}
