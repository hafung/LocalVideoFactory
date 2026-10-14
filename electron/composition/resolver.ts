import type { EditPlan, Scene } from '../../shared/edit-plan.js';
import { EditPlanSchema } from '../../shared/edit-plan.js';
import type { MediaMetadata } from '../media/probe.js';
import type { NarrationArtifact } from './narration.js';
import { estimateCaptionCues } from './captions.js';
import { spokenCharacterCount } from '../../shared/prosody.js';

export interface ResolvePlanOptions {
  narration: NarrationArtifact;
  sourceMetadata?: MediaMetadata;
  now?: Date;
}

function resolvedScenes(plan: EditPlan, narration: NarrationArtifact, sourceMetadata?: MediaMetadata): Scene[] {
  let sourceCursor = 0;
  const scenes: Scene[] = [];
  const byId = new Map(plan.scenes.map(scene => [scene.id, scene]));
  const actualTimings = new Map(narration.sceneTimings?.map(scene => [scene.id, scene]));
  const sceneSegments = narration.segments.flatMap((segment, index) => {
    const ids = segment.sceneIds ?? [byId.has(segment.id) ? segment.id : plan.scenes[index]?.id ?? plan.scenes.at(-1)!.id];
    const weights = ids.map(id => Math.max(1, spokenCharacterCount(byId.get(id)?.script ?? segment.text)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const speechStart = segment.speechStartMs ?? segment.startMs;
    const speechEnd = segment.speechEndMs ?? segment.endMs;
    const boundaries = [index === 0 ? 0 : segment.startMs];
    let accumulated = 0;
    for (let cursor = 0; cursor < ids.length - 1; cursor++) {
      accumulated += weights[cursor];
      const boundary = actualTimings.get(ids[cursor])?.endMs ?? Math.round(speechStart + (speechEnd - speechStart) * accumulated / total);
      boundaries.push(Math.max(boundaries[cursor] + 1, Math.min(segment.endMs - (ids.length - cursor - 1), boundary)));
    }
    boundaries.push(segment.endMs);
    return ids.map((id, cursor) => ({ id, startMs: boundaries[cursor], endMs: boundaries[cursor + 1] }));
  });
  for (const segment of sceneSegments) {
    const draft = byId.get(segment.id)!;
    if (!draft) throw new Error(`旁白引用不存在的分镜 ${segment.id}`);
    const duration = segment.endMs - segment.startMs;
    const sourceAvailable = plan.input.sourceVideoPath && sourceMetadata
      ? Math.max(0, (sourceMetadata.durationMs ?? 0) - sourceCursor)
      : 0;
    const sourceDuration = Math.min(duration, sourceAvailable);
    if (sourceDuration > 0) {
      scenes.push({
        ...draft,
        id: sourceDuration === duration ? draft.id : `${draft.id}-source`,
        startMs: segment.startMs,
        endMs: segment.startMs + sourceDuration,
        visual: {
          ...draft.visual,
          type: 'source',
          assetId: 'source-video',
          sourceInMs: sourceCursor,
          sourceOutMs: sourceCursor + sourceDuration,
          motion: 'none',
          intent: { ...draft.visual.intent, minDurationMs: sourceDuration }
        }
      });
      sourceCursor += sourceDuration;
    }
    if (sourceDuration < duration) {
      scenes.push({
        ...draft,
        id: sourceDuration > 0 ? `${draft.id}-fallback` : draft.id,
        startMs: segment.startMs + sourceDuration,
        endMs: segment.endMs,
        visual: {
          ...draft.visual,
          type: 'kinetic-text',
          assetId: undefined,
          sourceInMs: undefined,
          sourceOutMs: undefined,
          motion: 'slow-zoom-in',
          intent: { ...draft.visual.intent, minDurationMs: duration - sourceDuration }
        },
        transition: sourceDuration > 0 ? 'crossfade' : draft.transition
      });
    }
  }
  return scenes;
}

export function resolveEditPlan(plan: EditPlan, options: ResolvePlanOptions): EditPlan {
  if (plan.status !== 'draft') throw new Error('只有 draft EditPlan 可以解析');
  if (!options.narration.durationMs || !options.narration.audioPath) throw new Error('解析 EditPlan 前必须生成旁白');
  if (plan.input.sourceVideoPath && !options.sourceMetadata) throw new Error('提供原视频时必须先探测媒体时长');
  if (plan.input.sourceVideoPath && !options.sourceMetadata?.durationMs) throw new Error('原视频缺少有效时长');
  const now = (options.now ?? new Date()).toISOString();
  const resolved = {
    ...plan,
    revision: plan.revision + 1,
    updatedAt: now,
    status: 'resolved' as const,
    narration: {
      ...plan.narration,
      state: 'ready' as const,
      audioPath: options.narration.audioPath,
      durationMs: options.narration.durationMs,
      segments: options.narration.segments
    },
    scenes: resolvedScenes(plan, options.narration, options.sourceMetadata),
    captions: options.narration.captions ?? estimateCaptionCues(options.narration.segments, plan.template.captionHighlight)
  };
  return EditPlanSchema.parse(resolved);
}
