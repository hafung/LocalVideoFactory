import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { ModelDownloadsSchema, type ModelDownloads, type ModelSetupStatus } from '../shared/model-downloads.js';

type Descriptor = { path: string; sha256: string; size?: number };
type Verified = { sha256: string; size: number; mtimeMs: number };
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

// Keep incomplete downloads outside the installed application, so upgrades and
// restarting the app can reuse them without administrator privileges.
export async function downloadFile(url: string, target: string, signal: AbortSignal,
  progress: (bytes: number, total?: number) => void, descriptor?: Descriptor,
  request: typeof fetch = fetch): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    let timer = setTimeout(() => timeout.abort(new Error('模型下载超时')), 120_000);
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(new Error('模型下载超时')), 120_000); };
    try {
      let offset = await stat(partial).then(info => info.size).catch(() => 0);
      if (descriptor?.size === offset && await hash(partial) === descriptor.sha256) {
        await rename(partial, target); return;
      }
      const response = await request(url, { signal: AbortSignal.any([signal, timeout.signal]),
        headers: offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' } });
      if (response.status === 416) {
        await response.body?.cancel();
        if (descriptor && await hash(partial) === descriptor.sha256) { await rename(partial, target); return; }
        await rm(partial, { force: true });
        throw new Error('下载断点已失效，重新下载');
      }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`模型下载失败（HTTP ${response.status}）`); }
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== offset) { await response.body.cancel(); throw new Error('服务器返回了错误的下载断点'); }
        if (Number(range[2]) + 1 !== Number(range[3])) { await response.body.cancel(); throw new Error('服务器没有返回完整的剩余文件'); }
      } else offset = 0; // Servers that ignore Range must replace, never append.
      const length = Number(response.headers.get('content-length'));
      const total = length > 0 ? offset + length : descriptor?.size;
      let bytes = offset;
      progress(bytes, total);
      const body = response.body;
      async function* chunks() {
        const reader = body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            touch(); bytes += chunk.value.length; progress(bytes, total); yield chunk.value;
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      await pipeline(chunks(), createWriteStream(partial, { flags: offset ? 'a' : 'w' }),
        { signal: AbortSignal.any([signal, timeout.signal]) });
      if ((total && bytes !== total) || (descriptor?.size && bytes !== descriptor.size)) throw new Error('模型文件下载不完整');
      if (descriptor && await hash(partial) !== descriptor.sha256) {
        await rm(partial, { force: true }); throw new Error(`模型 SHA-256 校验失败：${descriptor.path}`);
      }
      await rename(partial, target);
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === 2) throw error;
      await delay(500 * (attempt + 1), undefined, { signal });
    } finally { clearTimeout(timer); }
  }
}

export class ModelDownloader {
  status: ModelSetupStatus = { state: 'checking', message: '正在检查本地模型…', completedFiles: 0, totalFiles: 0, downloadedBytes: 0 };
  private running?: Promise<void>;
  private controller = new AbortController();
  private verified: Record<string, Verified> = {};
  private lastPublished = 0;
  constructor(private catalogPath: string, readonly root: string,
    private publish: (status: ModelSetupStatus) => void,
    private request: typeof fetch = fetch) {}

  start(): Promise<void> {
    if (this.running) return this.running;
    this.controller = new AbortController();
    this.update({ state: 'checking', message: '正在检查本地模型…', completedFiles: 0, downloadedBytes: 0 });
    this.running = this.prepare().catch(error => {
      if (!this.controller.signal.aborted) this.update({ state: 'error', message: `${error instanceof Error ? error.message : String(error)}。请检查网络和磁盘空间后重试。` });
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  cancel(): void { this.controller.abort(); }
  private update(value: Partial<ModelSetupStatus>): void {
    this.status = { ...this.status, ...value };
    if (!('state' in value) && !('message' in value) && Date.now() - this.lastPublished < 250) return;
    this.lastPublished = Date.now(); this.publish({ ...this.status });
  }
  private async valid(file: Descriptor): Promise<boolean> {
    const target = path.join(this.root, file.path);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile() || !info.size || (file.size && info.size !== file.size)) return false;
    const previous = this.verified[file.path];
    if (previous?.sha256 === file.sha256 && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return true;
    return await hash(target) === file.sha256;
  }
  private async record(file: Descriptor): Promise<void> {
    const info = await stat(path.join(this.root, file.path));
    this.verified[file.path] = { sha256: file.sha256, size: info.size, mtimeMs: info.mtimeMs };
    await writeFile(path.join(this.root, '.verified.json'), JSON.stringify(this.verified));
    this.update({ completedFiles: this.status.completedFiles + 1 });
  }
  private async prepare(): Promise<void> {
    const catalog: ModelDownloads = ModelDownloadsSchema.parse(JSON.parse(await readFile(this.catalogPath, 'utf8')));
    await mkdir(this.root, { recursive: true });
    this.verified = await readFile(path.join(this.root, '.verified.json'), 'utf8').then(data => {
      const parsed: unknown = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Verified> : {};
    }).catch(() => ({}));
    this.update({ totalFiles: catalog.files.length + catalog.archives.reduce((sum, archive) => sum + archive.files.length, 0) });
    const signal = this.controller.signal;
    for (const file of catalog.files) {
      signal.throwIfAborted();
      if (!await this.valid(file)) {
        this.update({ state: 'downloading', message: `正在下载 ${file.path.split('/').slice(-2).join('/')}…`, downloadedBytes: 0, totalBytes: file.size });
        await downloadFile(file.url, path.join(this.root, file.path), signal,
          (downloadedBytes, totalBytes) => this.update({ downloadedBytes, totalBytes }), file, this.request);
      }
      await this.record(file);
    }
    for (const archive of catalog.archives) {
      signal.throwIfAborted();
      const ready = await Promise.all(archive.files.map(file => this.valid(file)));
      if (!ready.every(Boolean)) {
        const target = path.join(this.root, '.downloads', archive.path);
        this.update({ state: 'downloading', message: '正在下载 SenseVoice 字幕模型…', downloadedBytes: 0, totalBytes: undefined });
        if (!await stat(target).catch(() => undefined)) await downloadFile(archive.url, target, signal,
          (downloadedBytes, totalBytes) => this.update({ downloadedBytes, totalBytes }), undefined, this.request);
        const temporary = await mkdtemp(path.join(this.root, '.extract-'));
        try {
          this.update({ message: '正在解压并校验 SenseVoice 字幕模型…' });
          await promisify(execFile)(process.platform === 'win32' ? 'tar.exe' : 'tar',
            ['-xf', target, '-C', temporary, ...archive.files.map(file => file.member)], { windowsHide: true, signal });
          for (const file of archive.files) {
            const extracted = path.join(temporary, file.member);
            if (await hash(extracted) !== file.sha256) throw new Error(`SenseVoice SHA-256 校验失败：${file.path}`);
          }
          for (const file of archive.files) {
            await mkdir(path.dirname(path.join(this.root, file.path)), { recursive: true });
            await rename(path.join(temporary, file.member), path.join(this.root, file.path));
          }
        } finally {
          await rm(temporary, { recursive: true, force: true });
          await rm(target, { force: true });
        }
      }
      for (const file of archive.files) await this.record(file);
    }
    for (const manifest of catalog.manifests) {
      await mkdir(path.dirname(path.join(this.root, manifest.path)), { recursive: true });
      await writeFile(path.join(this.root, manifest.path), JSON.stringify(manifest.data, null, 2) + '\n');
    }
    this.update({ state: 'ready', message: '模型已就绪，可离线创作。' });
  }
}
