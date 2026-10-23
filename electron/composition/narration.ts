import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CaptionCue, EditPlan } from '../../shared/edit-plan.js';
import { composeSpeechWav } from '../../shared/wav.js';
import { DEFAULT_NARRATION_SEED, PROSODY_VERSION } from '../../shared/prosody.js';
import type { MediaProbe } from '../media/probe.js';

export interface NarrationVoiceOptions {
  language: string;
  temperature: number;
  topK: number;
  topP: number;
  seed?: number;
  precision: 'bf16' | 'int8' | 'int4';
  engineVersion: string;
  modelVersion: string;
  instruct?: string;
}

export interface NarrationProgress {
  phase: 'preparing' | 'generating' | 'composing' | 'probing';
  progress: number;
  message: string;
}

export interface SegmentSynthesisInput extends NarrationVoiceOptions {
  text: string;
  voiceId: string;
  outputPath: string;
  signal?: AbortSignal;
}

export interface NarrationSynthesizer {
  synthesize(input: SegmentSynthesisInput): Promise<void>;
}

export interface NarrationArtifact {
  audioPath: string;
  durationMs: number;
  segments: EditPlan['narration']['segments'];
  captions?: CaptionCue[];
  sceneTimings?: Array<{ id: string; startMs: number; endMs: number }>;
}

export interface NarrationServiceOptions {
  cacheDir: string;
  synthesizer: NarrationSynthesizer;
  probe: MediaProbe;
  voice: NarrationVoiceOptions;
}

function abortError(): Error {
  return new DOMException('旁白生成已取消', 'AbortError');
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export function narrationCacheKey(text: string, voiceId: string, options: NarrationVoiceOptions): string {
  const normalizedText = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return createHash('sha256').update(JSON.stringify({ normalizedText, voiceId, ...options, prosodyVersion: PROSODY_VERSION })).digest('hex');
}

export class NarrationService {
  constructor(private readonly options: NarrationServiceOptions) {}

  async generate(
    plan: EditPlan,
    workspace: string,
    signal?: AbortSignal,
    onProgress: (event: NarrationProgress) => void = () => undefined
  ): Promise<NarrationArtifact> {
    if (plan.status !== 'draft') throw new Error('只有 draft EditPlan 可以生成旁白');
    if (signal?.aborted) throw abortError();
    await mkdir(this.options.cacheDir, { recursive: true });
    const narrationDir = path.join(workspace, 'narration');
    await mkdir(narrationDir, { recursive: true });
    onProgress({ phase: 'preparing', progress: 0.02, message: '正在准备分段旁白…' });

    const chunks = plan.narration.chunks ?? plan.scenes.map(scene => ({
      id: scene.id, text: scene.script, sceneIds: [scene.id], pauseBeforeMs: 0, pauseAfterMs: 0
    }));
    // Every independent engine process must use the same sampling seed. Include
    // that resolved seed in the cache key as well as the synthesis request.
    const voice = { ...this.options.voice, seed: this.options.voice.seed ?? DEFAULT_NARRATION_SEED };
    const generated: Array<{ id: string; text: string; file: string; sceneIds: string[]; pauseBeforeMs: number; pauseAfterMs: number }> = [];
    for (const [index, chunk] of chunks.entries()) {
      if (signal?.aborted) throw abortError();
      const key = narrationCacheKey(chunk.text, plan.narration.voiceId, voice);
      const cached = path.join(this.options.cacheDir, `${key}.wav`);
      if (!await exists(cached)) {
        const pending = path.join(this.options.cacheDir, `.${key}.${randomUUID()}.wav`);
        try {
          await this.options.synthesizer.synthesize({
            ...voice,
            text: chunk.text,
            voiceId: plan.narration.voiceId,
            outputPath: pending,
            signal
          });
          if (signal?.aborted) throw abortError();
          try { await copyFile(pending, cached, 1); } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            if (code !== 'EEXIST') throw error;
          }
        } finally { await rm(pending, { force: true }); }
      }
      const segmentFile = path.join(narrationDir, `${chunk.id}.wav`);
      await copyFile(cached, segmentFile);
      const metadata = await this.options.probe.probe(segmentFile);
      if (!metadata.durationMs) throw new Error(`旁白分段 ${chunk.id} 缺少有效时长`);
      generated.push({ ...chunk, file: segmentFile });
      onProgress({
        phase: 'generating',
        progress: 0.05 + 0.8 * (index + 1) / chunks.length,
        message: `已完成第 ${index + 1}/${chunks.length} 段旁白`
      });
    }

    if (signal?.aborted) throw abortError();
    const audioPath = path.join(narrationDir, 'narration.wav');
    onProgress({ phase: 'composing', progress: 0.9, message: '正在拼接旁白…' });
    const timings = await composeSpeechWav(generated.map(segment => ({
      path: segment.file, pauseBeforeMs: segment.pauseBeforeMs, pauseAfterMs: segment.pauseAfterMs
    })), audioPath);
    if (signal?.aborted) throw abortError();
    onProgress({ phase: 'probing', progress: 0.96, message: '正在读取真实音频时长…' });
    const total = await this.options.probe.probe(audioPath);
    if (!total.durationMs) throw new Error('拼接旁白缺少有效时长');

    const segments = generated.map((segment, index) => {
      const timing = timings[index];
      return { id: segment.id, text: segment.text, sceneIds: segment.sceneIds,
        startMs: timing.startMs, endMs: index === generated.length - 1 ? total.durationMs! : timing.endMs,
        speechStartMs: timing.speechStartMs, speechEndMs: timing.speechEndMs, audioPath: segment.file };
    });
    return { audioPath, durationMs: total.durationMs, segments };
  }
}
