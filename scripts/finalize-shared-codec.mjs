import { readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Run before Electron Builder archives either the portable package or the installer.
export async function finalizeSharedCodec(root) {
  for (const model of ['qwen3-tts-1.7b-base', 'qwen3-tts-1.7b-customvoice']) {
    const manifestPath = path.join(root, 'models', model, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const entry of Object.values(manifest.files)) {
      if (!entry.path.startsWith('speech_tokenizer/')) continue;
      entry.path = `../qwen3-tts-tokenizer/${entry.path.slice('speech_tokenizer/'.length)}`;
      if (!(await stat(path.resolve(path.dirname(manifestPath), entry.path))).isFile()) throw new Error(`Missing shared codec: ${entry.path}`);
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

export default async function afterPack(context) {
  const root = path.join(context.appOutDir, 'resources');
  await finalizeSharedCodec(root);
  const { stdout } = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./verify-offline-resources.mjs', import.meta.url)), '--root', root, '--write-manifest'],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  console.log(stdout.trim());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await finalizeSharedCodec(path.resolve(process.argv[2]));
}
