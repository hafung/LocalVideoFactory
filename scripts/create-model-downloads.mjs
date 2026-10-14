import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function createModelDownloads(root) {
  const catalog = { schemaVersion: 1, files: [], archives: [], manifests: [] };
  const seen = new Map();
  for (const folder of ['qwen3-tts-1.7b-customvoice', 'qwen3-tts-1.7b-base']) {
    const manifest = JSON.parse(await readFile(path.join(root, 'models', folder, 'manifest.json'), 'utf8'));
    const source = manifest.source.replace('/tree/', '/resolve/');
    for (const descriptor of Object.values(manifest.files)) {
      const original = descriptor.path;
      const shared = original.startsWith('speech_tokenizer/');
      const destination = shared ? `models/qwen3-tts-tokenizer/${original.slice('speech_tokenizer/'.length)}` : `models/${folder}/${original}`;
      if (seen.has(destination) && seen.get(destination) !== descriptor.sha256) throw new Error(`Shared tokenizer mismatch: ${destination}`);
      if (!seen.has(destination)) {
        catalog.files.push({ path: destination, size: descriptor.size, sha256: descriptor.sha256,
          url: original === 'MODEL-LICENSE.txt' ? 'https://www.apache.org/licenses/LICENSE-2.0.txt' : `${source}/${original}` });
        seen.set(destination, descriptor.sha256);
      }
      if (shared) descriptor.path = `../qwen3-tts-tokenizer/${original.slice('speech_tokenizer/'.length)}`;
    }
    catalog.manifests.push({ path: `models/${folder}/manifest.json`, data: manifest });
  }
  const sense = JSON.parse(await readFile(path.join(root, 'models/sensevoice-small/manifest.json'), 'utf8'));
  const sensePath = 'models/sensevoice-small';
  catalog.archives.push({ path: 'sensevoice.tar.bz2', url: sense.source, files: [
    { ...sense.files.model, path: `${sensePath}/${sense.files.model.path}`, member: `${sense.version}/model.int8.onnx` },
    { ...sense.files.tokens, path: `${sensePath}/${sense.files.tokens.path}`, member: `${sense.version}/tokens.txt` },
    { ...sense.notices.modelPackage, path: `${sensePath}/SENSEVOICE-LICENSE`, member: `${sense.version}/LICENSE` }
  ] });
  for (const [descriptor, url] of [
    [sense.files.sileroVad, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'],
    [sense.notices.modelTerms, `https://raw.githubusercontent.com/modelscope/FunASR/${sense.notices.modelTerms.revision}/MODEL_LICENSE`],
    [sense.notices.sileroVad, 'https://raw.githubusercontent.com/snakers4/silero-vad/caddb3b7ce1dee88a14d5621a0e9a8fdeb2c2c48/LICENSE']
  ]) catalog.files.push({ path: `${sensePath}/${descriptor.path}`, sha256: descriptor.sha256, url });
  catalog.manifests.push({ path: `${sensePath}/manifest.json`, data: sense });
  catalog.files.push({ path: 'semantic/model/Qwen3-Embedding-0.6B-Q8_0.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
    sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439' });
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? 'resources');
  const catalog = await createModelDownloads(root);
  const project = path.resolve(process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { ModelDownloadsSchema } = await import(pathToFileURL(path.join(project, 'dist-electron/shared/model-downloads.js')).href);
  ModelDownloadsSchema.parse(catalog);
  await writeFile(path.join(root, 'model-downloads.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Model download catalog: ${catalog.files.length} files, ${catalog.archives.length} archive.`);
}
