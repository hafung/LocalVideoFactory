import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NARRATION_SEED } from '../shared/prosody.js';
import type { SynthesisRequest } from '../shared/types.js';
import { QwenEngine } from './engine.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn()
}));

let root: string;
let engine: QwenEngine;
let request: SynthesisRequest;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-engine-'));
  await writeFile(path.join(root, 'engine.exe'), '');
  await writeFile(path.join(root, 'model.safetensors'), '');
  await writeFile(path.join(root, 'config.json'), JSON.stringify({
    tts_model_type: 'custom_voice', talker_config: { hidden_size: 2048 }
  }));
  engine = new QwenEngine({ enginePath: path.join(root, 'engine.exe'), modelDir: root });
  request = { text: '第一段。\n\n第二段。', outputPath: path.join(root, 'output.wav'),
    language: 'Chinese', speaker: 'vivian', temperature: .5, topK: 50, topP: 1, threads: 4, precision: 'int8' };
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      // Produce a short PCM clip so the public synthesis path also composes it.
      const wav = Buffer.alloc(44 + 4800);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
      wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(4800, 40);
      await writeFile(args![args!.indexOf('-o') + 1], wav);
      child.emit('exit', 0);
    });
    return child as ChildProcess;
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const argument = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe('automatic narration engine requests', () => {
  it('uses the same seed and speaker across paragraphs without imposing a style instruction', async () => {
    await engine.synthesize(request, () => undefined);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [, args] of vi.mocked(spawn).mock.calls) {
      expect(argument(args!, '--seed')).toBe(String(DEFAULT_NARRATION_SEED));
      expect(args).not.toContain('--instruct');
      expect(argument(args!, '-s')).toBe('vivian');
    }
  });

  it('preserves explicit seed and style overrides', async () => {
    await engine.synthesize({ ...request, seed: 7, instruct: 'Speak warmly.' }, () => undefined);
    for (const [, args] of vi.mocked(spawn).mock.calls) {
      expect(argument(args!, '--seed')).toBe('7');
      expect(argument(args!, '--instruct')).toBe('Speak warmly.');
    }
  });

  it('keeps the raw synthesis opt-out free of automatic style and seed defaults', async () => {
    await engine.synthesize({ ...request, automaticProsody: false }, () => undefined);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    expect(args).not.toContain('--seed');
    expect(args).not.toContain('--instruct');
  });
});
