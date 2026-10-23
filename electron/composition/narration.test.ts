import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftEditPlan } from '../../shared/edit-plan.js';
import { DEFAULT_NARRATION_SEED } from '../../shared/prosody.js';
import { WavMediaProbe } from '../media/probe.js';
import { NarrationService, narrationCacheKey, type NarrationSynthesizer } from './narration.js';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))));

function wav(milliseconds: number): Buffer {
  const samples = Math.round(24_000 * milliseconds / 1000);
  const data = Buffer.alloc(samples * 2);
  const output = Buffer.alloc(44 + data.length);
  output.write('RIFF'); output.writeUInt32LE(36 + data.length, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(24_000, 24); output.writeUInt32LE(48_000, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(data.length, 40); data.copy(output, 44);
  return output;
}

const voice = {
  language: 'Chinese', temperature: 0.5, topK: 50, topP: 1,
  precision: 'int8' as const, engineVersion: 'test-engine', modelVersion: 'test-model'
};

describe('NarrationService', () => {
  it('generates reusable segments and probes the composed real duration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-narration-')); temporary.push(root);
    const synthesize = vi.fn(async (input: Parameters<NarrationSynthesizer['synthesize']>[0]) => {
      await writeFile(input.outputPath, wav(1200));
    });
    const service = new NarrationService({
      cacheDir: path.join(root, 'cache'), synthesizer: { synthesize }, probe: new WavMediaProbe(), voice
    });
    const plan = createDraftEditPlan({ id: 'narration', script: '第一段。第二段。', voiceId: 'vivian' });
    const first = await service.generate(plan, path.join(root, 'project'));
    const second = await service.generate(plan, path.join(root, 'project-two'));

    expect(first.durationMs).toBe(1200);
    expect(first.segments.map(segment => [segment.startMs, segment.endMs])).toEqual([[0, 1200]]);
    expect(first.segments[0].sceneIds).toEqual(['scene-001', 'scene-002']);
    expect(second.durationMs).toBe(1200);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls[0][0].text).toBe('第一段。第二段。');
    expect(synthesize.mock.calls[0][0].seed).toBe(DEFAULT_NARRATION_SEED);
  });

  it('includes automatic paragraph silence in the timeline and excludes it from speech bounds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-paragraphs-')); temporary.push(root);
    const service = new NarrationService({ cacheDir: path.join(root, 'cache'), probe: new WavMediaProbe(), voice,
      synthesizer: { synthesize: async input => { await writeFile(input.outputPath, wav(1200)); } } });
    const plan = createDraftEditPlan({ id: 'paragraphs', script: '第一段。\n\n第二段。', voiceId: 'vivian' });
    const result = await service.generate(plan, path.join(root, 'project'));
    expect(result.durationMs).toBe(2820);
    expect(result.segments.map(segment => [segment.startMs, segment.speechEndMs, segment.endMs])).toEqual([
      [0, 1200, 1620], [1620, 2820, 2820]
    ]);
  });

  it('reuses the same resolved seed across paragraphs and preserves an explicit seed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-seeds-')); temporary.push(root);
    const synthesize = vi.fn(async (input: Parameters<NarrationSynthesizer['synthesize']>[0]) => {
      await writeFile(input.outputPath, wav(1200));
    });
    const options = { cacheDir: path.join(root, 'cache'), probe: new WavMediaProbe(), synthesizer: { synthesize } };
    const plan = createDraftEditPlan({ id: 'seeds', script: '第一段。\n\n第二段。', voiceId: 'vivian' });
    await new NarrationService({ ...options, voice }).generate(plan, path.join(root, 'default'));
    expect(synthesize.mock.calls.map(([input]) => input.seed)).toEqual([DEFAULT_NARRATION_SEED, DEFAULT_NARRATION_SEED]);
    // An explicit default seed should hit exactly the same cached audio.
    await new NarrationService({ ...options, voice: { ...voice, seed: DEFAULT_NARRATION_SEED } }).generate(plan, path.join(root, 'same'));
    expect(synthesize).toHaveBeenCalledTimes(2);
    await new NarrationService({ ...options, voice: { ...voice, seed: 7 } }).generate(plan, path.join(root, 'custom'));
    expect(synthesize.mock.calls.slice(2).map(([input]) => input.seed)).toEqual([7, 7]);
  });

  it('uses every output-affecting voice option in its stable key', () => {
    const first = narrationCacheKey('  你好\n世界 ', 'vivian', voice);
    const normalized = narrationCacheKey('你好 世界', 'vivian', voice);
    const changed = narrationCacheKey('你好 世界', 'vivian', { ...voice, modelVersion: 'next' });
    expect(first).toBe(normalized);
    expect(changed).not.toBe(first);
    expect(narrationCacheKey('你好 世界', 'vivian', { ...voice, instruct: 'Speak naturally.' })).not.toBe(first);
  });

  it('stops before spawning synthesis when already cancelled', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-narration-')); temporary.push(root);
    const synthesize = vi.fn();
    const service = new NarrationService({
      cacheDir: path.join(root, 'cache'), synthesizer: { synthesize }, probe: new WavMediaProbe(), voice
    });
    const controller = new AbortController(); controller.abort();
    const plan = createDraftEditPlan({ id: 'cancelled', script: '不要启动子进程。', voiceId: 'vivian' });
    await expect(service.generate(plan, path.join(root, 'project'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(synthesize).not.toHaveBeenCalled();
  });
});
