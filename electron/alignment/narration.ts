import type { EditPlan, CaptionHighlight } from '../../shared/edit-plan.js';
import { spokenCharacterCount } from '../../shared/prosody.js';
import type { NarrationArtifact } from '../composition/narration.js';
import { estimateCaptionCues } from '../composition/captions.js';
import { alignedCaptionCues, alignTextTokens } from './align-text.js';
import { alignWithSenseVoiceProcess, type SenseVoiceProcessResult } from './sensevoice-process.js';

type Transcribe = (file: string, signal?: AbortSignal) => Promise<SenseVoiceProcessResult>;

/** Align only the finished speech clips. Their offsets already include all inserted pauses. */
export async function alignNarration(
  narration: NarrationArtifact, scenes: EditPlan['scenes'], transcribe: Transcribe,
  signal?: AbortSignal, onFallback: (message: string) => void = () => undefined, highlight?: CaptionHighlight
): Promise<NarrationArtifact> {
  const captions: NonNullable<NarrationArtifact['captions']> = [];
  const sceneTimings: NonNullable<NarrationArtifact['sceneTimings']> = [];
  const byId = new Map(scenes.map(scene => [scene.id, scene]));
  for (const segment of narration.segments) {
    if (signal?.aborted) throw new DOMException('字幕对齐已取消', 'AbortError');
    try {
      if (!segment.audioPath) throw new Error('旁白缺少音频分段');
      const result = await transcribe(segment.audioPath, signal);
      const tokens = result.tokens.map(token => ({ ...token, startMs: token.startMs + segment.startMs,
        endMs: token.endMs === undefined ? undefined : token.endMs + segment.startMs }));
      const startMs = segment.speechStartMs ?? segment.startMs;
      const endMs = result.speechEndMs === undefined ? segment.speechEndMs ?? segment.endMs
        : Math.min(segment.speechEndMs ?? segment.endMs, segment.startMs + result.speechEndMs);
      const aligned = alignTextTokens(segment.text, tokens, startMs, endMs);
      if (!aligned.length || aligned.filter(token => token.source === 'aligned').length / aligned.length < 0.55) {
        throw new Error('识别文本与文案匹配不足');
      }
      captions.push(...alignedCaptionCues(segment.id, segment.text, tokens, startMs, endMs, highlight));
      const ids = segment.sceneIds ?? [segment.id];
      let characters = 0;
      for (const [index, id] of ids.entries()) {
        const scene = byId.get(id);
        if (!scene) continue;
        const first = index === 0 ? segment.startMs : aligned[characters]?.startMs ?? endMs;
        characters += spokenCharacterCount(scene.script);
        const last = index === ids.length - 1 ? segment.endMs : aligned[characters]?.startMs ?? endMs;
        sceneTimings.push({ id, startMs: first, endMs: last });
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      captions.push(...estimateCaptionCues([segment], highlight));
      onFallback(`${segment.id}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...narration, captions, sceneTimings };
}

export function senseVoiceNarrationTranscriber(resources: string): Transcribe {
  return (file, signal) => alignWithSenseVoiceProcess(resources, file, undefined, undefined, signal);
}
