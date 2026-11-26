import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { OnlineSource } from '../../../shared/library.js';
import { USER_AGENT, type OnlineAdapter, type RemoteMedia } from './adapter.js';

type FailureKind = 'invalid' | 'cooldown' | 'timeout' | 'network' | 'download';
export class OnlineFailure extends Error {
  constructor(readonly kind: FailureKind, readonly waitMs?: number) {
    super({ invalid: 'API Key 无效或权限不足', cooldown: '请求受限，已暂停访问',
      timeout: '请求超时', network: '连接或响应异常', download: '下载或导入失败' }[kind]);
  }
}

export function safeFailure(error: unknown, fallback: FailureKind): OnlineFailure {
  if (error instanceof OnlineFailure) return error;
  return new OnlineFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : fallback);
}

function retryAfter(headers: Headers, now: number) {
  const value = headers.get('retry-after')?.trim();
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) || 0) - now);
}

export function rateWait(source: OnlineSource, response: Response, now: number) {
  const headers = response.headers;
  const retry = retryAfter(headers, now);
  if (response.status !== 429 && headers.get('x-ratelimit-remaining') !== '0' && headers.get('ratelimit-remaining') !== '0') return retry;
  const resetValue = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
  const reset = Number(resetValue);
  const resetMs = reset > 1_000_000_000 ? reset * 1000 - now : reset * 1000;
  return Math.max(retry, resetMs || 0) || (source === 'pexels' || source === 'coverr' ? 60 * 60_000 : 60_000);
}

const maxBytes = 500 * 1024 * 1024;
export class OnlineTransport {
  constructor(private readonly fetcher: typeof fetch, private readonly now: () => number) {}

  async api(source: OnlineSource, url: URL, init: RequestInit | undefined, signal: AbortSignal, cooldown: (ms: number) => void) {
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', USER_AGENT);
    const result = await this.fetcher(url, { ...init, headers, signal, redirect: 'error' });
    const wait = rateWait(source, result, this.now());
    if (wait) cooldown(wait);
    if (result.ok) return result;
    await result.body?.cancel();
    if (result.status === 429 || (result.status === 503 && wait)) throw new OnlineFailure('cooldown', wait);
    if (result.status === 401 || result.status === 403 || (source === 'pixabay' && result.status === 400))
      throw new OnlineFailure('invalid');
    throw new OnlineFailure('network');
  }

  async media(adapter: OnlineAdapter, value: string, signal: AbortSignal, cooldown: (ms: number) => void, range?: string) {
    const headers = new Headers({ 'User-Agent': USER_AGENT });
    if (range && /^bytes=\d*-\d*$/u.test(range)) headers.set('Range', range);
    let next: string | undefined = value;
    for (let hop = 0; hop < 4 && next; hop++) {
      signal.throwIfAborted();
      const url = adapter.mediaUrl(next);
      if (!url) break;
      const response = await this.fetcher(url, { headers, signal, redirect: 'manual' });
      if (response.ok && response.body) {
        const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
        if (!mime || mime === 'application/octet-stream' || (mime.startsWith('image/') && mime !== 'image/svg+xml') || mime.startsWith('video/')) return response;
      }
      await response.body?.cancel();
      if (response.status === 429 || response.status === 503) {
        cooldown(rateWait(adapter.source, response, this.now()) || 60_000);
        break;
      }
      const location = response.headers.get('location');
      next = [301, 302, 303, 307, 308].includes(response.status) && location ? new URL(location, url).href : undefined;
    }
    throw new OnlineFailure('download');
  }

  async download(adapter: OnlineAdapter, item: RemoteMedia, directory: string, signal: AbortSignal, cooldown: (ms: number) => void) {
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${adapter.source}-${randomUUID()}${item.extension}`);
    const temporary = `${filePath}.part`;
    const bodySignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const response = await this.media(adapter, item.download, bodySignal, cooldown);
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body!.cancel();
      throw new OnlineFailure('download');
    }
    try {
      const file = await open(temporary, 'wx');
      try {
        let bytes = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          bodySignal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new OnlineFailure('download');
          await file.writeFile(chunk);
        }
        if (!bytes) throw new OnlineFailure('download');
        bodySignal.throwIfAborted();
      } finally { await file.close(); }
      await rename(temporary, filePath);
      return filePath;
    } finally {
      if (!response.body!.locked) await response.body!.cancel().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
}
