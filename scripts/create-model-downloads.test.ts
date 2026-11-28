import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ModelDownloadsSchema } from '../shared/model-downloads.js';

it('builds a validated catalog from pinned models with one shared codec and preserved manifests', async () => {
  const { createModelDownloads } = await import(pathToFileURL(path.resolve('scripts/create-model-downloads.mjs')).href);
  const catalog = ModelDownloadsSchema.parse(await createModelDownloads(path.resolve('resources')));
  expect(new Set(catalog.files.map(file => file.path)).size).toBe(catalog.files.length);
  expect(catalog.files.filter(file => file.path.endsWith('qwen3-tts-tokenizer/model.safetensors'))).toHaveLength(1);
  expect(catalog.files.some(file => file.path.includes('/speech_tokenizer/'))).toBe(false);
  for (const folder of ['qwen3-tts-1.7b-customvoice', 'qwen3-tts-1.7b-base']) {
    const manifest = JSON.parse(await readFile(path.resolve('resources/models', folder, 'manifest.json'), 'utf8'));
    expect(catalog.files.find(file => file.path === `models/${folder}/model.safetensors`)).toMatchObject({
      sha256: manifest.files['model.safetensors'].sha256,
      url: manifest.source.replace('/tree/', '/resolve/') + '/model.safetensors'
    });
    const packed = catalog.manifests.find(item => item.path === `models/${folder}/manifest.json`)!;
    expect((packed.data.files as Record<string, { path: string }>)['speech_tokenizer/model.safetensors'].path).toBe('../qwen3-tts-tokenizer/model.safetensors');
  }
  expect(catalog.archives).toHaveLength(0);
  expect(catalog.files.find(file => file.path === 'models/sensevoice-small/model.int8.onnx')).toMatchObject({
    url: expect.stringContaining('huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/'),
    mirrors: { modelscope: expect.stringContaining('modelscope.cn/models/') }
  });
  expect(catalog.files.map(file => file.path)).toContain('semantic/model/Qwen3-Embedding-0.6B-Q8_0.gguf');
  const scene = JSON.parse(await readFile('resources/scene-planner/manifest.json', 'utf8'));
  for (const file of [scene.modelFile, scene.projectorFile]) {
    expect(catalog.files.find(item => item.path === `scene-planner/${file}`)).toMatchObject({
      sha256: scene.files.find(item => item.path === file).sha256,
      url: `${scene.quantizationSource}/resolve/${scene.revision}/${path.posix.basename(file)}?download=true`
    });
  }
  expect(catalog.manifests.find(item => item.path === 'scene-planner/manifest.json')?.data).toEqual(scene);
});
