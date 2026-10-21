import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RecognizedToken } from './align-text.js';

const require = createRequire(import.meta.url);

const ResourceDescriptorSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict();

const ResourceManifestSchema = z.object({
  version: z.string().min(1),
  source: z.string().url(),
  license: z.string().min(1),
  files: z.object({
    model: ResourceDescriptorSchema,
    tokens: ResourceDescriptorSchema,
    sileroVad: ResourceDescriptorSchema
  }).strict(),
  notices: z.record(z.string(), ResourceDescriptorSchema.extend({ revision: z.string().optional() })).optional()
}).strict();

export interface SenseVoiceResources {
  model: string;
  tokens: string;
  sileroVad: string;
  version: string;
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function verifySenseVoiceResources(root: string): Promise<SenseVoiceResources> {
  const resolvedRoot = path.resolve(root);
  const manifest = ResourceManifestSchema.parse(JSON.parse(await readFile(path.join(resolvedRoot, 'manifest.json'), 'utf8')));
  const entries = Object.entries(manifest.files) as Array<[keyof typeof manifest.files, { path: string; sha256?: string }]>;
  const resolved = {} as Record<keyof typeof manifest.files, string>;
  for (const [name, descriptor] of entries) {
    const file = path.resolve(resolvedRoot, descriptor.path);
    if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`SenseVoice 资源路径越界：${name}`);
    await access(file);
    if (descriptor.sha256 && await sha256(file) !== descriptor.sha256) throw new Error(`SenseVoice 资源校验失败：${name}`);
    resolved[name] = file;
  }
  return { ...resolved, version: manifest.version };
}

interface SherpaResult { tokens: string[]; timestamps: number[]; durations: number[]; ys_log_probs?: number[] }
interface SherpaModule {
  readWave(file: string, enableExternalBuffer?: boolean): { samples: Float32Array; sampleRate: number };
  Vad: new (config: unknown, bufferSizeInSeconds: number) => {
    acceptWaveform(samples: Float32Array): void; isEmpty(): boolean;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array }; pop(): void; flush(): void;
  };
  OfflineRecognizer: { createAsync(config: unknown): Promise<{
    createStream(): { acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void };
    decodeAsync(stream: unknown): Promise<SherpaResult>;
  }> };
}

let onnxRuntime: unknown;
function loadSherpa(): SherpaModule {
  if (process.platform === 'win32' && !onnxRuntime) {
    const sherpaRequire = createRequire(require.resolve('sherpa-onnx-node'));
    const directory = path.dirname(sherpaRequire.resolve('sherpa-onnx-win-x64'));
    const dll = path.join(directory, 'onnxruntime.dll').replace(/\.asar([\\/])/u, '.asar.unpacked$1');
    // Preload the exact bundled DLL before Windows can resolve the older System32 copy.
    // Keep the library alive for all recognizers/VADs in this isolated worker.
    onnxRuntime = (require('koffi') as { load(file: string): unknown }).load(dll);
  }
  return require('sherpa-onnx-node') as SherpaModule;
}

export class SenseVoiceAdapter {
  constructor(private readonly resources: SenseVoiceResources) {}

  async transcribe(audioPath: string, signal?: AbortSignal): Promise<RecognizedToken[]> {
    if (signal?.aborted) throw new DOMException('字幕对齐已取消', 'AbortError');
    const sherpa = loadSherpa();
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: this.resources.model, language: 'zh', useInverseTextNormalization: 1 },
        tokens: this.resources.tokens, numThreads: 4, provider: 'cpu', debug: 0
      }
    });
    if (signal?.aborted) throw new DOMException('字幕对齐已取消', 'AbortError');
    const stream = recognizer.createStream();
    // Electron's V8 memory cage rejects external native ArrayBuffers. Ask
    // sherpa to copy audio into a runtime-owned buffer in both worker modes.
    stream.acceptWaveform(sherpa.readWave(audioPath, false));
    const result = await recognizer.decodeAsync(stream);
    return (result.tokens ?? []).map((text, index) => {
      const startSeconds = result.timestamps?.[index] ?? 0;
      const durationSeconds = result.durations?.[index];
      const logProbability = result.ys_log_probs?.[index];
      return {
        text,
        startMs: Math.max(0, Math.round(startSeconds * 1000)),
        endMs: durationSeconds === undefined ? undefined : Math.max(1, Math.round((startSeconds + durationSeconds) * 1000)),
        confidence: logProbability === undefined ? undefined : Math.max(0, Math.min(1, Math.exp(logProbability)))
      };
    });
  }

  async speechRanges(audioPath: string): Promise<Array<{ startMs: number; endMs: number }>> {
    const sherpa = loadSherpa();
    const wave = sherpa.readWave(audioPath, false);
    const sampleRate = 16_000;
    const samples = wave.sampleRate === sampleRate ? wave.samples : resampleLinear(wave.samples, wave.sampleRate, sampleRate);
    const vad = new sherpa.Vad({
      sileroVad: {
        model: this.resources.sileroVad, threshold: 0.5, minSilenceDuration: 0.25,
        minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 30
      },
      sampleRate, numThreads: 1, provider: 'cpu', debug: 0
    }, Math.max(10, Math.ceil(samples.length / sampleRate) + 2));
    for (let offset = 0; offset < samples.length; offset += 512) vad.acceptWaveform(samples.slice(offset, offset + 512));
    vad.flush();
    const ranges: Array<{ startMs: number; endMs: number }> = [];
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      ranges.push({ startMs: Math.round(segment.start / sampleRate * 1000),
        endMs: Math.round((segment.start + segment.samples.length) / sampleRate * 1000) });
      vad.pop();
    }
    return ranges;
  }

  async speechEndMs(audioPath: string): Promise<number | undefined> {
    return (await this.speechRanges(audioPath)).at(-1)?.endMs;
  }

  /** Decode detected speech only: music and silence must not become invented dialogue. */
  async transcribeSpeech(audioPath: string): Promise<{ tokens: RecognizedToken[]; speechSegments: Array<{ startMs: number; endMs: number }> }> {
    const speechSegments = await this.speechRanges(audioPath);
    if (!speechSegments.length) return { tokens: [], speechSegments };
    const sherpa = loadSherpa();
    const wave = sherpa.readWave(audioPath, false);
    const recognizer = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: { senseVoice: { model: this.resources.model, language: 'auto', useInverseTextNormalization: 1 },
        tokens: this.resources.tokens, numThreads: 4, provider: 'cpu', debug: 0 }
    });
    const tokens: RecognizedToken[] = [];
    for (const segment of speechSegments) {
      const offsetMs = Math.max(0, segment.startMs - 80);
      const samples = wave.samples.slice(Math.floor(offsetMs / 1000 * wave.sampleRate),
        Math.ceil((segment.endMs + 80) / 1000 * wave.sampleRate));
      const stream = recognizer.createStream(); stream.acceptWaveform({ samples, sampleRate: wave.sampleRate });
      const result = await recognizer.decodeAsync(stream);
      for (const [index, text] of (result.tokens ?? []).entries()) {
        const startMs = offsetMs + Math.round((result.timestamps?.[index] ?? 0) * 1000);
        const endMs = offsetMs + Math.round(((result.timestamps?.[index] ?? 0) + (result.durations?.[index] ?? .06)) * 1000);
        const logProbability = result.ys_log_probs?.[index];
        if (text && !/^<.*>$/u.test(text)) tokens.push({ text, startMs, endMs: Math.max(startMs + 1, endMs),
          confidence: logProbability === undefined ? undefined : Math.max(0, Math.min(1, Math.exp(logProbability))) });
      }
    }
    return { tokens, speechSegments };
  }
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate <= 0 || targetRate <= 0) throw new Error('无效的音频采样率');
  const output = new Float32Array(Math.max(1, Math.round(input.length * targetRate / sourceRate)));
  for (let index = 0; index < output.length; index++) {
    const position = index * sourceRate / targetRate;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[index] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}
