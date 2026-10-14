import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const REQUIRED_FILES = [
  'browser/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'browser/chrome-headless-shell-win64/LICENSE.headless_shell',
  'browser/manifest.json',
  'engine/qwen_tts.exe',
  'engine/libopenblas.dll',
  'engine/libwinpthread-1.dll',
  'engine/QWEN3-TTS-C-LICENSE',
  'engine/INGOT-LICENSE',
  'engine/OPENBLAS-LICENSE',
  'engine/LZ4-LICENSE',
  'engine/WINPTHREADS-LICENSE',
  'engine/THIRD-PARTY-NOTICES.txt',
  'engine/build-info.json',
  'engine/manifest.json',
  'models/qwen3-tts-1.7b-customvoice/config.json',
  'models/qwen3-tts-1.7b-customvoice/generation_config.json',
  'models/qwen3-tts-1.7b-customvoice/tokenizer_config.json',
  'models/qwen3-tts-1.7b-customvoice/preprocessor_config.json',
  'models/qwen3-tts-1.7b-customvoice/model.safetensors',
  'models/qwen3-tts-1.7b-customvoice/vocab.json',
  'models/qwen3-tts-1.7b-customvoice/merges.txt',
  'models/qwen3-tts-1.7b-customvoice/speech_tokenizer/config.json',
  'models/qwen3-tts-1.7b-customvoice/speech_tokenizer/configuration.json',
  'models/qwen3-tts-1.7b-customvoice/speech_tokenizer/preprocessor_config.json',
  'models/qwen3-tts-1.7b-customvoice/speech_tokenizer/model.safetensors',
  'models/qwen3-tts-1.7b-customvoice/MODEL-LICENSE.txt',
  'models/qwen3-tts-1.7b-customvoice/manifest.json',
  'models/qwen3-tts-1.7b-base/config.json',
  'models/qwen3-tts-1.7b-base/generation_config.json',
  'models/qwen3-tts-1.7b-base/tokenizer_config.json',
  'models/qwen3-tts-1.7b-base/preprocessor_config.json',
  'models/qwen3-tts-1.7b-base/model.safetensors',
  'models/qwen3-tts-1.7b-base/vocab.json',
  'models/qwen3-tts-1.7b-base/merges.txt',
  'models/qwen3-tts-1.7b-base/speech_tokenizer/config.json',
  'models/qwen3-tts-1.7b-base/speech_tokenizer/configuration.json',
  'models/qwen3-tts-1.7b-base/speech_tokenizer/preprocessor_config.json',
  'models/qwen3-tts-1.7b-base/speech_tokenizer/model.safetensors',
  'models/qwen3-tts-1.7b-base/MODEL-LICENSE.txt',
  'models/qwen3-tts-1.7b-base/manifest.json',
  'models/sensevoice-small/model.int8.onnx',
  'models/sensevoice-small/tokens.txt',
  'models/sensevoice-small/silero_vad.onnx',
  'models/sensevoice-small/SENSEVOICE-LICENSE',
  'models/sensevoice-small/SENSEVOICE-MODEL-LICENSE',
  'models/sensevoice-small/SILERO-LICENSE',
  'models/sensevoice-small/manifest.json',
  'ffmpeg/ffmpeg.exe',
  'ffmpeg/ffprobe.exe',
  'ffmpeg/LICENSE.txt',
  'ffmpeg/manifest.json',
  'cli/voxweave.cmd'
];

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(normalize(path.relative(root, absolute)));
  }
  return files;
}

async function verifyDeclaredHashes(root, relativeManifest, runtimeOnly = false) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, relativeManifest), 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    return [`${relativeManifest}: manifest is not valid JSON`];
  }
  const descriptorGroups = [manifest.files ?? {}, manifest.notices ?? {}];
  const descriptors = descriptorGroups.flatMap(group => Array.isArray(group) ? group : Object.values(group));
  const failures = [];
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.path !== 'string' || !descriptor.sha256) continue;
    const relative = normalize(path.join(path.dirname(relativeManifest), descriptor.path));
    if (runtimeOnly && relative.startsWith('semantic/model/')) continue;
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      failures.push(`${relativeManifest}: resource path escapes root`);
      continue;
    }
    try {
      const actual = await sha256(absolute);
      if (actual !== descriptor.sha256.toLowerCase()) failures.push(`${relative}: SHA-256 mismatch`);
    } catch {
      failures.push(`${relative}: declared file is missing`);
    }
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : path.join(process.cwd(), 'resources'));
  const writeManifest = args.includes('--write-manifest');
  const runtimeOnly = args.includes('--runtime-only');
  const missing = [];
  const sharedCodec = await stat(path.join(root, 'models/qwen3-tts-tokenizer')).then(info => info.isDirectory()).catch(() => false);
  const requiredFiles = runtimeOnly
    ? [...REQUIRED_FILES.filter(file => !file.startsWith('models/')), 'model-downloads.json',
      'semantic/manifest.json', 'semantic/runtime/llama-server.exe', 'semantic/runtime/llama-server-impl.dll',
      'semantic/LLAMA-LICENSE.txt', 'semantic/QWEN-LICENSE.txt']
    : sharedCodec
    ? [...REQUIRED_FILES.filter(file => !file.includes('/speech_tokenizer/')),
      ...['config.json', 'configuration.json', 'preprocessor_config.json', 'model.safetensors'].map(file => `models/qwen3-tts-tokenizer/${file}`)]
    : REQUIRED_FILES;
  for (const relative of requiredFiles) {
    try {
      const info = await stat(path.join(root, relative));
      if (!info.isFile() || info.size === 0) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }

  const semanticModel = path.join(root, 'semantic/model');
  const semanticRuntime = path.join(root, 'semantic/runtime');
  const semanticPresent = await Promise.all([semanticModel, semanticRuntime].map(directory =>
    stat(directory).then(info => info.isDirectory()).catch(() => false)));
  if (semanticPresent.some(Boolean)) {
    for (const relative of [
      'semantic/manifest.json',
      ...(!runtimeOnly ? ['semantic/model/Qwen3-Embedding-0.6B-Q8_0.gguf'] : []),
      'semantic/runtime/llama-server.exe',
      'semantic/runtime/llama-server-impl.dll',
      'semantic/LLAMA-LICENSE.txt',
      'semantic/QWEN-LICENSE.txt'
    ]) {
      try {
        if (!(await stat(path.join(root, relative))).isFile()) missing.push(relative);
      } catch { missing.push(relative); }
    }
  }

  if (missing.length) {
    console.error(`Offline resource closure is incomplete (${missing.length} missing):`);
    for (const relative of missing) console.error(`  - ${relative}`);
  }

  const hashFailures = [
    ...await verifyDeclaredHashes(root, 'browser/manifest.json'),
    ...await verifyDeclaredHashes(root, 'engine/manifest.json'),
    ...(!runtimeOnly ? [
      ...await verifyDeclaredHashes(root, 'models/qwen3-tts-1.7b-customvoice/manifest.json'),
      ...await verifyDeclaredHashes(root, 'models/qwen3-tts-1.7b-base/manifest.json'),
      ...await verifyDeclaredHashes(root, 'models/sensevoice-small/manifest.json')
    ] : []),
    ...await verifyDeclaredHashes(root, 'ffmpeg/manifest.json'),
    ...await verifyDeclaredHashes(root, 'semantic/manifest.json', runtimeOnly)
  ];
  if (hashFailures.length) {
    console.error('Offline resource hash verification failed:');
    for (const failure of hashFailures) console.error(`  - ${failure}`);
  }
  if (missing.length || hashFailures.length) {
    process.exitCode = 1;
    return;
  }

  const relativeFiles = (await listFiles(root))
    .filter(relative => relative !== '.gitkeep' && relative !== 'offline-manifest.json' && relative !== 'runtime-manifest.json')
    .sort();
  if (runtimeOnly && relativeFiles.some(file => file.startsWith('models/') || file.startsWith('semantic/model/'))) {
    throw new Error('Online installer must not contain model resources.');
  }
  const files = [];
  for (const relative of relativeFiles) {
    const absolute = path.join(root, relative);
    const info = await stat(absolute);
    files.push({ path: relative, size: info.size, sha256: await sha256(absolute) });
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    layout: runtimeOnly ? 'installer-download-models' : 'directory-portable',
    files
  };
  if (writeManifest) {
    await writeFile(path.join(root, runtimeOnly ? 'runtime-manifest.json' : 'offline-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`Offline resources verified: ${files.length} files, ${totalBytes} bytes${writeManifest ? '; manifest written' : ''}.`);
}

await main();
