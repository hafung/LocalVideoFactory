import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile, ModelDownloader } from './model-downloads.js';
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
