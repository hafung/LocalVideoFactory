import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExternalTtsNarrationSynthesizer,
  normalizeExternalTtsBaseUrl,
  testExternalTtsConnection
} from './external-tts.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function makePcmWav(samples = 240): Buffer {
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe('external OpenAI-compatible TTS integration', () => {
  it('normalizes host, /v1, and full /v1/audio/speech URLs', () => {
    expect(normalizeExternalTtsBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeExternalTtsBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080/v1');
    expect(normalizeExternalTtsBaseUrl('http://127.0.0.1:8080/v1/audio/speech')).toBe('http://127.0.0.1:8080/v1');
    expect(() => normalizeExternalTtsBaseUrl('ftp://127.0.0.1:8080')).toThrow('http:// 或 https://');
    expect(() => normalizeExternalTtsBaseUrl('')).toThrow('请填写');
  });

  it('discovers models and voices from AudioCpp-Desktop style endpoints', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3-tts-0.6b' }, { id: 'cosyvoice3' }] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.endsWith('/v1/audio/voices')) {
        return new Response(JSON.stringify({ voices: [{ name: 'vivian' }, { name: 'my-clone' }] }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('unexpected', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await testExternalTtsConnection({
      baseUrl: 'http://127.0.0.1:8080',
      model: 'qwen3-tts-0.6b',
      voice: 'vivian',
      request: fetcher
    });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['qwen3-tts-0.6b', 'cosyvoice3']);
    expect(result.voices).toEqual(['vivian', 'my-clone']);
  });

  it('falls back to /v1/audio/speech probe when discovery endpoints are unavailable', async () => {
    const wav = makePcmWav();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/audio/speech')) {
        expect(init?.method).toBe('POST');
        return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await testExternalTtsConnection({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen3-tts',
      voice: 'default',
      request: fetcher
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('音频合成测试');
  });

  it('synthesizes narration segments via OpenAI /v1/audio/speech and forwards auth header', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'voxweave-ext-tts-test-'));
    tempDirs.push(dir);
    const wav = makePcmWav();
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:8080/v1/audio/speech');
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
    }) as unknown as typeof fetch;

    const synth = new ExternalTtsNarrationSynthesizer({
      baseUrl: 'http://127.0.0.1:8080',
      apiKey: 'secret-token',
      model: 'qwen3-tts-0.6b',
      voice: 'my-voice',
      speed: 1.1,
      request: fetcher
    });
    const outFile = path.join(dir, 'seg.wav');
    await synth.synthesize({
      text: '你好，欢迎使用帧舟。',
      voiceId: 'vivian',
      outputPath: outFile,
      language: 'Chinese',
      temperature: 0.5,
      topK: 50,
      topP: 1,
      precision: 'int8',
      engineVersion: 'external',
      modelVersion: 'test'
    });
    expect(capturedAuth).toBe('Bearer secret-token');
    expect(capturedBody).toEqual({
      model: 'qwen3-tts-0.6b',
      input: '你好，欢迎使用帧舟。',
      voice: 'my-voice',
      response_format: 'wav',
      speed: 1.1
    });
    expect((await readFile(outFile)).equals(wav)).toBe(true);
  });

  it('surfaces JSON error responses clearly', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'voxweave-ext-tts-err-'));
    tempDirs.push(dir);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'model not loaded' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch;

    const synth = new ExternalTtsNarrationSynthesizer({
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'qwen3-tts',
      voice: 'default',
      request: fetcher
    });
    await expect(synth.synthesize({
      text: '测试',
      voiceId: 'vivian',
      outputPath: path.join(dir, 'seg.wav'),
      language: 'Chinese',
      temperature: 0.5,
      topK: 50,
      topP: 1,
      precision: 'int8',
      engineVersion: 'external',
      modelVersion: 'test'
    })).rejects.toThrow('model not loaded');
  });
});
