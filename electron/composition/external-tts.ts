import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExternalTtsTestResult } from '../../shared/types.js';
import type { NarrationSynthesizer, SegmentSynthesisInput } from './narration.js';

const execFileAsync = promisify(execFile);

export interface ExternalTtsRuntimeConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  speed?: number;
  ffmpegPath?: string;
  request?: typeof fetch;
}

/**
 * Normalizes an OpenAI-compatible TTS server URL so users can enter
 * `http://127.0.0.1:8080`, `http://127.0.0.1:8080/v1`, or the full
 * `http://127.0.0.1:8080/v1/audio/speech` endpoint.
 */
export function normalizeExternalTtsBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('请填写本地或外部 TTS API 地址（例如 http://127.0.0.1:8080/v1）');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('TTS API 地址格式无效，请以 http:// 或 https:// 开头');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TTS API 地址仅支持 http:// 或 https://');
  }
  parsed.search = '';
  parsed.hash = '';
  let pathname = parsed.pathname.replace(/\/+$/u, '');
  if (pathname.endsWith('/audio/speech')) pathname = pathname.slice(0, -'/audio/speech'.length);
  if (!pathname) pathname = '/v1';
  parsed.pathname = pathname;
  return parsed.href.replace(/\/+$/u, '');
}

function authHeaders(apiKey?: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (apiKey?.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  return headers;
}

function isStandardPcmWav(buffer: Buffer): boolean {
  if (buffer.length < 44) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false;
  let offset = 12;
  let hasFmt = false;
  let hasData = false;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size === 0xffffffff || start + size > buffer.length) return false;
    if (id === 'fmt ') {
      if (size < 16) return false;
      const audioFormat = buffer.readUInt16LE(start);
      const bitsPerSample = buffer.readUInt16LE(start + 14);
      if (audioFormat !== 1 || bitsPerSample !== 16) return false;
      hasFmt = true;
    } else if (id === 'data') {
      if (size === 0) return false;
      hasData = true;
    }
    offset = start + size + (size % 2);
  }
  return hasFmt && hasData;
}

function extractNames(payload: unknown, keys: string[]): string[] {
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) seen.add(value.trim());
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const field of ['id', 'name', 'voice', 'voice_id']) {
        if (typeof record[field] === 'string' && record[field].trim()) {
          seen.add(record[field].trim());
          break;
        }
      }
    }
  };
  if (Array.isArray(payload)) {
    for (const item of payload) add(item);
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      const collection = record[key];
      if (Array.isArray(collection)) {
        for (const item of collection) add(item);
      }
    }
  }
  return [...seen];
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string };
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : parsed.error?.message ?? parsed.detail ?? parsed.message;
    if (message) return `HTTP ${response.status}：${message}`;
  } catch { /* plain text response */ }
  return `HTTP ${response.status}：${text.slice(0, 200)}`;
}

async function synthesizeSpeechBytes(
  config: ExternalTtsRuntimeConfig,
  text: string,
  voiceOverride?: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; contentType: string }> {
  const baseUrl = normalizeExternalTtsBaseUrl(config.baseUrl);
  const request = config.request ?? fetch;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('外部 TTS 服务响应超时')), 180_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const body: Record<string, unknown> = {
      model: config.model.trim() || 'qwen3-tts',
      input: text,
      voice: (voiceOverride?.trim() || config.voice.trim() || 'default'),
      response_format: 'wav'
    };
    if (config.speed !== undefined && Number.isFinite(config.speed)) {
      body.speed = Math.min(2, Math.max(0.5, config.speed));
    }
    const response = await request(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: authHeaders(config.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: combinedSignal
    });
    if (!response.ok) {
      throw new Error(`外部 TTS 合成失败（${await readErrorBody(response)}）`);
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('外部 TTS 返回了空音频');
    if (contentType.includes('application/json') || contentType.includes('text/html')) {
      throw new Error(`外部 TTS 返回了非音频内容（${contentType}）：${buffer.toString('utf8').slice(0, 160)}`);
    }
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

export async function testExternalTtsConnection(
  config: ExternalTtsRuntimeConfig,
  signal?: AbortSignal
): Promise<ExternalTtsTestResult> {
  const baseUrl = normalizeExternalTtsBaseUrl(config.baseUrl);
  const request = config.request ?? fetch;
  const headers = authHeaders(config.apiKey);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('连接外部 TTS 服务超时')), 15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let models: string[] = [];
  let voices: string[] = [];
  let discoveryReached = false;
  try {
    const [modelsResult, voicesResult] = await Promise.allSettled([
      request(`${baseUrl}/models`, { headers, signal: combinedSignal }),
      request(`${baseUrl}/audio/voices`, { headers, signal: combinedSignal })
    ]);
    if (modelsResult.status === 'fulfilled' && modelsResult.value.ok) {
      discoveryReached = true;
      models = extractNames(await modelsResult.value.json().catch(() => undefined), ['data', 'models']);
    }
    if (voicesResult.status === 'fulfilled' && voicesResult.value.ok) {
      discoveryReached = true;
      voices = extractNames(await voicesResult.value.json().catch(() => undefined), ['voices', 'data']);
    }
  } finally {
    clearTimeout(timer);
  }

  if (discoveryReached) {
    const summary = [
      models.length ? `发现 ${models.length} 个模型` : '',
      voices.length ? `发现 ${voices.length} 个音色` : ''
    ].filter(Boolean).join('，');
    return {
      ok: true,
      models,
      voices,
      message: summary ? `连接成功（${summary}）` : '连接成功，服务响应正常。'
    };
  }

  // Some servers (e.g. minimal OpenAI TTS proxies) only expose POST /v1/audio/speech.
  await synthesizeSpeechBytes(config, '你好。', config.voice, signal);
  return {
    ok: true,
    models,
    voices,
    message: '连接成功，已完成音频合成测试。'
  };
}

export class ExternalTtsNarrationSynthesizer implements NarrationSynthesizer {
  constructor(private readonly config: ExternalTtsRuntimeConfig) {}

  async synthesize(input: SegmentSynthesisInput): Promise<void> {
    if (input.signal?.aborted) throw new DOMException('旁白生成已取消', 'AbortError');
    const voice = this.config.voice.trim() || input.voiceId || 'default';
    const { buffer } = await synthesizeSpeechBytes(this.config, input.text, voice, input.signal);
    if (input.signal?.aborted) throw new DOMException('旁白生成已取消', 'AbortError');
    await mkdir(path.dirname(input.outputPath), { recursive: true });
    if (this.config.ffmpegPath) {
      const temp = await mkdtemp(path.join(os.tmpdir(), 'voxweave-ext-tts-'));
      try {
        const rawPath = path.join(temp, 'speech.audio');
        await writeFile(rawPath, buffer);
        await execFileAsync(this.config.ffmpegPath, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', rawPath, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', input.outputPath
        ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal: input.signal });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      return;
    }
    if (!isStandardPcmWav(buffer)) {
      throw new Error('外部 TTS 返回的音频不是标准 PCM WAV，且当前缺少内置 FFmpeg 进行转码');
    }
    await writeFile(input.outputPath, buffer);
  }
}
