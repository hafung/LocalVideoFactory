import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveSceneModelPaths } from './scene-model.js';
import { parseSceneIntents } from './scene-planner.js';
import { createDraftEditPlan } from '../../shared/edit-plan.js';

it('finds a relocated bundled model when a developer override is stale, and respects explicit disable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-model-path-'));
  try {
    const runtime = path.join(root, 'semantic/runtime'); const models = path.join(root, 'scene-planner/model');
    await mkdir(runtime, { recursive: true }); await mkdir(models, { recursive: true });
    await writeFile(path.join(runtime, 'llama-server.exe'), 'runtime');
    const model = path.join(models, 'local.gguf'); await writeFile(model, 'GGUF');
    await writeFile(path.join(root, 'scene-planner/manifest.json'), JSON.stringify({ modelFile: 'model/local.gguf', files: [{ path: 'model/local.gguf', size: 4 }] }));
    expect(resolveSceneModelPaths(root, '/other', '/developer/missing.gguf')).toMatchObject({ modelPath: model, bundled: true });
    expect(resolveSceneModelPaths(root, '/other', '/developer/missing.gguf', false, '/developer/missing.exe')).toMatchObject({ modelPath: model, bundled: true });
    expect(resolveSceneModelPaths(root, root, undefined, true)).toEqual({});
    await writeFile(path.join(root, 'scene-planner/manifest.json'), JSON.stringify({ modelFile: '../outside.gguf' }));
    expect(resolveSceneModelPaths(root, root)).toEqual({});
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts only existing scene IDs and valid intent fields from model output', () => {
  const plan = createDraftEditPlan({ id: 'llm', script: '产品细节。', voiceId: 'vivian' });
  const result = parseSceneIntents('<think>thinking</think>```json\n' + JSON.stringify({ scenes: [
    { id: 'unknown', keywords: ['wrong'], pexelsQuery: 'wrong' },
    { id: 'scene-001', keywords: ['产品特写'], pexelsQuery: 'product closeup' },
    { id: 'scene-001', keywords: ['duplicate'], pexelsQuery: 'duplicate' }
  ] }) + '\n```', plan.scenes);
  expect([...result]).toEqual([['scene-001', { keywords: ['产品特写'], pexelsQuery: 'product closeup' }]]);
});
