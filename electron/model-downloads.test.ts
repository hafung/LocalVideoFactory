import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadFile,
  getDirectoryUsage,
  migrateModelDirectory,
  ModelDownloader,
  resolveDownloadUrls
} from './model-downloads.js';
import { ModelDownloadsSchema, type ModelDownloads } from '../shared/model-downloads.js';

const directories: string[] = [];
const content = 'verified model bytes';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const descriptor = { path: 'models/test.bin', sha256: digest(content), size: Buffer.byteLength(content) };
afterEach(async () => { await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-download-')); directories.push(root); return root;
}
const request = (callback: (url: string, options: RequestInit) => Promise<Response> | Response) =>
  vi.fn(callback) as unknown as typeof fetch;
async function writeResource(root: string, relative: string, value = content) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
  return file;
}

describe('resumable model downloads', () => {
  it('resumes an interrupted download and only promotes a verified file', async () => {
    const target = path.join(await temporary(), 'test.bin');
    await writeFile(`${target}.part`, content.slice(0, 8));
    const fetcher = request((_url, options) => {
      expect(options.headers).toMatchObject({ Range: 'bytes=8-' });
      return new Response(content.slice(8), { status: 206, headers: {
        'content-range': `bytes 8-${content.length - 1}/${content.length}`, 'content-length': String(content.length - 8)
      } });
    });
    await downloadFile('https://example.org/model', target, new AbortController().signal, () => {}, descriptor, fetcher);
    expect(await readFile(target, 'utf8')).toBe(content);
    expect(await stat(`${target}.part`).catch(() => undefined)).toBeUndefined();
  });
  it('replaces the partial file when the server ignores Range', async () => {
    const target = path.join(await temporary(), 'test.bin');
    await writeFile(`${target}.part`, 'old partial');
    await downloadFile('https://example.org/model', target, new AbortController().signal, () => {}, descriptor,
      request(() => new Response(content)));
    expect(await readFile(target, 'utf8')).toBe(content);
  });
  it('recovers from a stale Range and starts again from zero', async () => {
    const target = path.join(await temporary(), 'test.bin');
    await writeFile(`${target}.part`, 'stale bytes');
    let count = 0;
    await downloadFile('https://example.org/model', target, new AbortController().signal, () => {}, descriptor,
      request((_url, options) => {
        if (count++ === 0) return new Response(null, { status: 416 });
        expect(options.headers).not.toHaveProperty('Range'); return new Response(content);
      }));
    expect(await readFile(target, 'utf8')).toBe(content);
  });
  it('never exposes corrupt bytes as a completed model', async () => {
    const target = path.join(await temporary(), 'test.bin');
    const fetcher = request(() => new Response('x'.repeat(content.length)));
    await expect(downloadFile('https://example.org/model', target, new AbortController().signal, () => {}, descriptor, fetcher)).rejects.toThrow('SHA-256');
    expect(await stat(target).catch(() => undefined)).toBeUndefined();
    expect(await stat(`${target}.part`).catch(() => undefined)).toBeUndefined();
  });
  it('reuses an already complete partial file without a request', async () => {
    const target = path.join(await temporary(), 'test.bin');
    await writeFile(`${target}.part`, content);
    const fetcher = vi.fn();
    await downloadFile('https://example.org/model', target, new AbortController().signal, () => {}, descriptor, fetcher);
    expect(fetcher).not.toHaveBeenCalled(); expect(await readFile(target, 'utf8')).toBe(content);
  });
  it('leaves a usable partial file when cancelled', async () => {
    const target = path.join(await temporary(), 'test.bin');
    const controller = new AbortController();
    let chunks = 0;
    const fetcher = request(() => new Response(new ReadableStream({
      async pull(stream) {
        if (chunks++ === 0) { stream.enqueue(new TextEncoder().encode(content.slice(0, 8))); return; }
        await new Promise<void>(resolve => { controller.signal.addEventListener('abort', () => resolve(), { once: true }); setTimeout(() => controller.abort(), 30); });
        stream.error(controller.signal.reason);
      }
    })));
    await expect(downloadFile('https://example.org/model', target, controller.signal, () => {}, descriptor, fetcher)).rejects.toThrow();
    expect(await readFile(`${target}.part`, 'utf8')).toBe(content.slice(0, 8));
    expect(await stat(target).catch(() => undefined)).toBeUndefined();
  });
});

describe('first launch model preparation', () => {
  it('prepares only basic models at startup and downloads each optional pack independently', async () => {
    const root = await temporary();
    const basic = descriptor.path;
    const tokenizer = 'models/qwen3-tts-tokenizer/model.safetensors';
    const clone = 'models/qwen3-tts-1.7b-base/model.safetensors';
    const search = 'semantic/model/Qwen3-Embedding-0.6B-Q8_0.gguf';
    const scene = ['scene-planner/model/Qwen3.5-4B-Q4_K_M.gguf', 'scene-planner/model/mmproj-F16.gguf'];
    const sceneManifest = 'scene-planner/manifest.json';
    const cache = path.join(root, 'cache');
    const catalogPath = await writeResource(root, 'catalog.json', JSON.stringify({
      schemaVersion: 1,
      files: [basic, tokenizer, clone, search, ...scene].map(file => ({
        ...descriptor, path: file, url: `https://example.org/${file}`
      })),
      archives: [],
      manifests: [{ path: sceneManifest, data: { modelFile: scene[0], projectorFile: scene[1] } }]
    }));
    const network = request(() => new Response(content));
    const basicDownload = new ModelDownloader(catalogPath, cache, () => {}, network, undefined, 'basic');
    const sceneDownload = new ModelDownloader(catalogPath, cache, () => {}, network, undefined, 'scene');
    const cloneDownload = new ModelDownloader(catalogPath, cache, () => {}, network, undefined, 'clone');

    await basicDownload.start();
    expect(basicDownload.status).toMatchObject({ state: 'ready', completedFiles: 2 });
    expect(network).toHaveBeenCalledTimes(2);
    expect(await stat(path.join(cache, sceneManifest)).catch(() => undefined)).toBeUndefined();

    await Promise.all([sceneDownload.start(), cloneDownload.start()]);
    expect(sceneDownload.status).toMatchObject({ state: 'ready', completedFiles: 2 });
    expect(cloneDownload.status).toMatchObject({ state: 'ready', completedFiles: 1 });
    expect(network).toHaveBeenCalledTimes(5);
    for (const file of [basic, tokenizer, clone, ...scene]) expect(await readFile(path.join(cache, file), 'utf8')).toBe(content);
    expect(await stat(path.join(cache, search)).catch(() => undefined)).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(cache, '.verified-scene.json'), 'utf8'))).toHaveProperty(scene[0]);
    expect(JSON.parse(await readFile(path.join(cache, '.verified-clone.json'), 'utf8'))).toHaveProperty(clone);
  });

  it('imports a complete manual setup including the shared tokenizer and extracted archive without fetching', async () => {
    const root = await temporary();
    const manual = await temporary();
    const tts = 'models/qwen3-tts-1.7b-customvoice/model.safetensors';
    const tokenizer = 'models/qwen3-tts-tokenizer/model.safetensors';
    const embedding = 'semantic/model/Qwen3-Embedding-0.6B-Q8_0.gguf';
    const sense = 'models/sensevoice-small/model.int8.onnx';
    const custom = await writeResource(manual, 'voice-weights/model.safetensors');
    await writeResource(manual, 'models/qwen3-tts-1.7b-base/speech_tokenizer/model.safetensors');
    const gguf = await writeResource(manual, 'weights/embedding.gguf');
    await writeResource(manual, sense);
    const catalog: ModelDownloads = {
      schemaVersion: 1,
      files: [tts, tokenizer, embedding].map(relative => ({ ...descriptor, path: relative, url: 'https://example.org/model' })),
      archives: [{ path: 'sensevoice.tar.bz2', url: 'https://example.org/archive', files: [{ ...descriptor, path: sense, member: 'sense/model.int8.onnx' }] }],
      manifests: [{ path: 'models/sensevoice-small/manifest.json', data: { version: 'test' } }]
    };
    const catalogPath = await writeResource(root, 'catalog.json', JSON.stringify(catalog));
    const cache = path.join(root, 'cache');
    await writeResource(cache, tts, 'x'.repeat(content.length));
    const network = vi.fn(() => { throw new Error('network must not be used'); });
    const downloader = new ModelDownloader(catalogPath, cache, () => {}, network,
      () => ({ roots: [manual], narrationModelDir: path.dirname(custom), embeddingModelPath: gguf }));

    await downloader.start();

    expect(network).not.toHaveBeenCalled();
    expect(downloader.status).toMatchObject({ state: 'ready', completedFiles: 4 });
    for (const relative of [tts, tokenizer, embedding, sense]) expect(await readFile(path.join(cache, relative), 'utf8')).toBe(content);
    expect(await readFile(custom, 'utf8')).toBe(content);
    expect(JSON.parse(await readFile(path.join(cache, catalog.manifests[0].path), 'utf8'))).toEqual({ version: 'test' });
    expect(await readdir(path.dirname(path.join(cache, tts)))).toEqual(['model.safetensors']);
  });

  it('imports valid local files before fetching and downloads only missing or invalid entries', async () => {
    const root = await temporary();
    const manual = await temporary();
    const invalid = { ...descriptor, path: 'models/wrong.bin', url: 'https://example.org/wrong' };
    const valid = { ...descriptor, url: 'https://example.org/valid' };
    const archiveMember = { ...descriptor, path: 'models/sense/tokens.txt', member: 'sense/tokens.txt' };
    await writeResource(manual, invalid.path, 'x'.repeat(content.length));
    await writeResource(manual, valid.path);
    await writeResource(manual, archiveMember.path);
    const catalog: ModelDownloads = {
      schemaVersion: 1, files: [invalid, valid],
      archives: [{ path: 'sense.tar.bz2', url: 'https://example.org/archive', files: [archiveMember] }], manifests: []
    };
    const catalogPath = await writeResource(root, 'catalog.json', JSON.stringify(catalog));
    const cache = path.join(root, 'cache');
    const network = request(async url => {
      expect(url).toBe(invalid.url);
      expect(await readFile(path.join(cache, valid.path), 'utf8')).toBe(content);
      expect(await readFile(path.join(cache, archiveMember.path), 'utf8')).toBe(content);
      expect(await stat(path.join(cache, invalid.path)).catch(() => undefined)).toBeUndefined();
      return new Response(content);
    });
    const downloader = new ModelDownloader(catalogPath, cache, () => {}, network, () => ({ roots: [manual] }));

    await downloader.start();

    expect(network).toHaveBeenCalledTimes(1);
    expect(downloader.status).toMatchObject({ state: 'ready', completedFiles: 3 });
    expect(await readFile(path.join(manual, invalid.path), 'utf8')).toBe('x'.repeat(content.length));
    expect((await readdir(path.join(cache, 'models'))).sort()).toEqual(['sense', 'test.bin', 'wrong.bin']);
  });

  it('switches from an active download to a newly selected source without concurrent writes', async () => {
    const root = await temporary();
    const manual = await temporary();
    await writeResource(manual, descriptor.path);
    const catalog = { schemaVersion: 1, files: [{ ...descriptor, url: 'https://example.org/file' }], archives: [], manifests: [] };
    const catalogPath = await writeResource(root, 'catalog.json', JSON.stringify(catalog));
    const cache = path.join(root, 'cache');
    let fetchStarted!: () => void;
    const startedFetch = new Promise<void>(resolve => { fetchStarted = resolve; });
    const network = request((_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      fetchStarted();
    }));
    let sources: string[] = [];
    const downloader = new ModelDownloader(catalogPath, cache, () => {}, network, () => ({ roots: sources }));

    const onlineAttempt = downloader.start();
    await startedFetch;
    sources = [manual];
    await Promise.all([onlineAttempt, downloader.restart(), downloader.restart()]);

    expect(network).toHaveBeenCalledTimes(1);
    expect(downloader.status).toMatchObject({ state: 'ready', completedFiles: 1 });
    expect(await readFile(path.join(cache, descriptor.path), 'utf8')).toBe(content);
  });

  it('extracts and verifies archive members, then restarts offline and repairs changed files', async () => {
    const source = await temporary();
    await mkdir(path.join(source, 'sense'));
    await writeFile(path.join(source, 'sense/model.bin'), content);
    const archive = path.join(source, 'model.tar.bz2');
    await promisify(execFile)(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-cjf', archive, '-C', source, 'sense/model.bin']);
    const archiveBytes = await readFile(archive);
    const root = await temporary();
    const catalog: ModelDownloads = {
      schemaVersion: 1, files: [{ ...descriptor, url: 'https://example.org/direct' }],
      archives: [{ path: 'sense.tar.bz2', url: 'https://example.org/archive', files: [
        { path: 'models/sense/model.bin', member: 'sense/model.bin', sha256: digest(content) }
      ] }], manifests: [{ path: 'models/sense/manifest.json', data: { version: 'test' } }]
    };
    const catalogPath = path.join(source, 'catalog.json'); await writeFile(catalogPath, JSON.stringify(catalog));
    const fetcher = request(url => new Response(url.endsWith('archive') ? archiveBytes : content));
    const downloader = new ModelDownloader(catalogPath, root, () => {}, fetcher);
    const first = downloader.start(); expect(downloader.start()).toBe(first); await first;
    expect(downloader.status.state).toBe('ready');
    expect(await readFile(path.join(root, 'models/sense/model.bin'), 'utf8')).toBe(content);
    expect(JSON.parse(await readFile(path.join(root, 'models/sense/manifest.json'), 'utf8'))).toEqual({ version: 'test' });
    const offline = request(() => { throw new Error('network must not be used'); });
    const restarted = new ModelDownloader(catalogPath, root, () => {}, offline);
    await restarted.start(); expect(restarted.status.state).toBe('ready'); expect(offline).not.toHaveBeenCalled();
    await writeFile(path.join(root, '.verified.json'), 'null');
    const damagedCache = new ModelDownloader(catalogPath, root, () => {}, offline);
    await damagedCache.start(); expect(damagedCache.status.state).toBe('ready'); expect(offline).not.toHaveBeenCalled();
    await writeFile(path.join(root, descriptor.path), 'damaged model');
    await downloader.start(); expect(downloader.status.state).toBe('ready');
    expect(await readFile(path.join(root, descriptor.path), 'utf8')).toBe(content);
  });
  it('reports failure, and a manual retry can recover', async () => {
    const root = await temporary(); const catalogPath = path.join(root, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, files: [{ ...descriptor, url: 'https://example.org/file' }], archives: [], manifests: [] }));
    let fail = true;
    const downloader = new ModelDownloader(catalogPath, path.join(root, 'cache'), () => {},
      request(() => new Response(fail ? 'bad bytes' : content)));
    await downloader.start(); expect(downloader.status.state).toBe('error');
    fail = false; await downloader.start(); expect(downloader.status.state).toBe('ready');
  });
  it('rejects paths outside the cache and insecure download URLs', () => {
    const catalog = { schemaVersion: 1, files: [{ ...descriptor, path: '../escape', url: 'https://example.org/model' }], archives: [], manifests: [] };
    expect(() => ModelDownloadsSchema.parse(catalog)).toThrow();
    expect(() => ModelDownloadsSchema.parse({ ...catalog, files: [{ ...descriptor, url: 'http://example.org/model' }] })).toThrow();
  });
});

describe('china mirrors, setup inspection, and storage migration', () => {
  it('rewrites HuggingFace URLs for HF-Mirror and ModelScope with fallback chain', () => {
    const hfUrl = 'https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/0c0e3051/config.json?download=true';
    expect(resolveDownloadUrls(hfUrl, 'official')).toEqual([hfUrl]);
    expect(resolveDownloadUrls(hfUrl, 'hf-mirror')).toEqual([
      'https://hf-mirror.com/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/0c0e3051/config.json?download=true',
      hfUrl
    ]);
    expect(resolveDownloadUrls(hfUrl, 'modelscope')).toEqual([
      'https://www.modelscope.cn/models/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/master/config.json',
      'https://hf-mirror.com/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/resolve/0c0e3051/config.json?download=true',
      hfUrl
    ]);
    expect(resolveDownloadUrls(hfUrl, 'modelscope', {
      modelscope: 'https://www.modelscope.cn/models/custom/repo/resolve/master/config.json'
    })[0]).toBe('https://www.modelscope.cn/models/custom/repo/resolve/master/config.json');
  });

  it('falls back to the next mirror when the preferred mirror returns 404 or bad SHA-256', async () => {
    const root = await temporary();
    const target = path.join(root, 'config.json');
    const seen: string[] = [];
    const fetcher = request(url => {
      seen.push(url);
      if (url.includes('modelscope.cn')) return new Response('not found', { status: 404 });
      if (url.includes('hf-mirror.com')) return new Response('x'.repeat(content.length));
      return new Response(content);
    });
    const urls = resolveDownloadUrls('https://huggingface.co/Qwen/Test/resolve/main/config.json', 'modelscope');
    await downloadFile(urls, target, new AbortController().signal, () => {}, descriptor, fetcher);
    expect(seen).toEqual(urls);
    expect(await readFile(target, 'utf8')).toBe(content);
  });

  it('inspects without creating files or fetching, reporting setup when missing and ready when present', async () => {
    const root = await temporary();
    const cache = path.join(root, 'storage');
    const catalogPath = await writeResource(root, 'catalog.json', JSON.stringify({
      schemaVersion: 1,
      files: [{ ...descriptor, url: 'https://huggingface.co/Qwen/Test/resolve/main/test.bin' }],
      archives: [],
      manifests: [{ path: 'models/manifest.json', data: { ok: true } }]
    }));
    const network = vi.fn(() => { throw new Error('inspect must not fetch'); });
    const downloader = new ModelDownloader(catalogPath, cache, () => {}, network);
    expect(await downloader.inspect()).toBe(false);
    expect(downloader.status.state).toBe('setup');
    expect(await stat(cache).catch(() => undefined)).toBeUndefined();
    expect(network).not.toHaveBeenCalled();

    await writeResource(cache, descriptor.path, content);
    expect(await downloader.inspect()).toBe(true);
    expect(downloader.status.state).toBe('ready');
    expect(JSON.parse(await readFile(path.join(cache, 'models/manifest.json'), 'utf8'))).toEqual({ ok: true });
  });

  it('migrates managed model files safely, preserves unrelated files, and rejects nested targets', async () => {
    const root = await temporary();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await writeResource(source, 'models/qwen3-tts-1.7b-customvoice/config.json', content);
    await writeResource(source, 'semantic/model/embed.gguf', 'embedding-data');
    await writeResource(source, '.verified.json', '{"ok":true}');
    await writeResource(source, 'unrelated-user-note.txt', 'keep me');

    expect(await getDirectoryUsage(source)).toBe(
      Buffer.byteLength(content) + Buffer.byteLength('embedding-data') + Buffer.byteLength('{"ok":true}')
    );
    await expect(migrateModelDirectory(source, source)).rejects.toThrow('不能与当前模型目录相同或互相包含');
    await expect(migrateModelDirectory(source, path.join(source, 'sub'))).rejects.toThrow('不能与当前模型目录相同或互相包含');

    const progressEvents: number[] = [];
    const migration = await migrateModelDirectory(source, target, info => progressEvents.push(info.completedFiles));
    expect(migration.migratedFiles).toBe(3);
    expect(progressEvents.at(-1)).toBe(3);
    expect(await readFile(path.join(target, 'models/qwen3-tts-1.7b-customvoice/config.json'), 'utf8')).toBe(content);
    expect(await readFile(path.join(target, 'semantic/model/embed.gguf'), 'utf8')).toBe('embedding-data');
    expect(await readFile(path.join(target, '.verified.json'), 'utf8')).toBe('{"ok":true}');
    expect(await stat(path.join(target, 'unrelated-user-note.txt')).catch(() => undefined)).toBeUndefined();

    const failedCleanup = await migration.cleanupOld();
    expect(failedCleanup).toEqual([]);
    expect(await stat(path.join(source, 'models')).catch(() => undefined)).toBeUndefined();
    expect(await readFile(path.join(source, 'unrelated-user-note.txt'), 'utf8')).toBe('keep me');
  });
});
