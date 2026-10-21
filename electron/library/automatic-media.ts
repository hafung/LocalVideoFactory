import { EditPlanSchema, type EditPlan, type Scene } from '../../shared/edit-plan.js';
import type { MediaAsset, OnlineAsset } from '../../shared/library.js';
import { englishSearchQuery } from '../../shared/keywords.js';

export interface AutomaticMediaProvider {
  search(query: string, type: 'video' | 'image', orientation: 'portrait' | 'landscape' | 'square', signal: AbortSignal): Promise<OnlineAsset[]>;
  download(id: string, signal: AbortSignal): Promise<MediaAsset>;
}

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
      let candidates: OnlineAsset[];
      try { candidates = await provider.search(query, type, scene.visual.intent.orientation, signal); }
      catch (error) {
        signal.throwIfAborted();
        warnings.add(`Pexels ${type === 'video' ? '视频' : '图片'}搜索未完成：${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        continue;
      }
      candidates = candidates.filter(item => item.type === type && !used.has(item.sourceUrl) &&
        (type === 'image' || (item.durationMs ?? 0) >= 1000));
      if (type === 'video') candidates.sort((a, b) => Number((a.durationMs ?? 0) < scene.endMs - cursor) - Number((b.durationMs ?? 0) < scene.endMs - cursor));
      let failures = 0;
      for (const item of candidates) {
        if (cursor === scene.endMs || failures >= 3) break;
        signal.throwIfAborted();
        try {
          const asset = await provider.download(item.id, signal);
          signal.throwIfAborted();
          if (asset.type !== type || asset.license.status === 'unknown') throw new Error('素材类型或授权不符合自动选片要求');
          const length = Math.min(scene.endMs - cursor, type === 'image' ? 2000 : asset.durationMs ?? 0);
          if (length <= 0) throw new Error('视频没有有效时长');
          used.add(item.sourceUrl);
          pieces.push({ ...scene, startMs: cursor, endMs: cursor + length,
            originSceneId: scene.originSceneId ?? scene.id,
            visual: { ...scene.visual, type, assetId: asset.id,
              sourceInMs: type === 'video' ? 0 : undefined, sourceOutMs: type === 'video' ? length : undefined,
              motion: type === 'image' ? 'slow-zoom-in' : 'none', intent: { ...scene.visual.intent, minDurationMs: length } } });
          cursor += length;
        } catch (error) {
          signal.throwIfAborted(); failures++;
          warnings.add(`部分在线素材下载失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
        }
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
