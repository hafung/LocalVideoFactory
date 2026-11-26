import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { onlineSourceInfo, onlineSources, type CoverrTier, type MediaAsset, type OnlineAsset, type OnlineDownloadResult,
  type OnlineSearchRequest, type OnlineSearchResult, type OnlineSource, type OnlineSourceStatus } from '../../../shared/library.js';
import { pexelsAdapter } from '../pexels.js';
import { DAY, matchesOrientation, type OnlineAdapter, type ProviderAccess, type ProviderSearch, type RemoteMedia, type RemotePage } from './adapter.js';
import type { OnlineMediaCache } from './cache.js';
import { coverrAdapter } from './coverr.js';
import { pixabayAdapter } from './pixabay.js';
import { OnlineFailure, OnlineTransport, safeFailure } from './transport.js';
import { wikimediaAdapter } from './wikimedia.js';

export interface SourceCredentials {
  key: string; storedKey?: boolean; unavailable?: boolean; tier?: CoverrTier;
}
interface SourceState {
  cooldown: number; mediaCooldown: number; invalid: boolean; queue: Promise<void>; nextRequest: number;
}
interface SourceContext {
  adapter: OnlineAdapter; access: ProviderAccess; scope: string; rateKey: string; state: SourceState;
}
interface SearchContext {
  request: OnlineSearchRequest; provider: ProviderSearch; source: SourceContext;
}
interface ResultHandle {
  item: RemoteMedia; context: SearchContext; expires: number;
}
type ImportMedia = (item: RemoteMedia, filePath: string, minDurationMs: number, signal: AbortSignal) => Promise<MediaAsset>;
type Failure = [OnlineSource, OnlineFailure];
interface VisitOptions { automatic?: boolean; after?: OnlineSource }
const adapters: Record<OnlineSource, OnlineAdapter> = {
  pexels: pexelsAdapter, pixabay: pixabayAdapter, coverr: coverrAdapter, wikimedia: wikimediaAdapter
};

function raceAbort<T>(signal: AbortSignal, task: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class OnlineMediaService {
  private readonly states = new Map<OnlineSource, { rateKey: string; state: SourceState }>();
  private readonly cache = new Map<string, { expires: number; page: RemotePage }>();
  private readonly handles = new Map<string, ResultHandle>();
  private readonly transport: OnlineTransport;

  constructor(private readonly options: {
    credentials: (source: OnlineSource) => SourceCredentials;
    persistence: OnlineMediaCache;
    directory: string;
    importMedia: ImportMedia;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.transport = new OnlineTransport(options.fetch ?? fetch, () => this.now());
  }

  private now() { return this.options.now?.() ?? Date.now(); }

  private context(source: OnlineSource, credentials = this.options.credentials(source)): SourceContext {
    const tier = credentials.tier ?? 'demo';
    const rateKey = createHash('sha256').update(JSON.stringify([source, credentials.key])).digest('hex');
    const scope = `${rateKey}:${tier}`;
    const previous = this.states.get(source);
    const now = this.now();
    const state = previous?.rateKey === rateKey ? previous.state : {
      cooldown: this.options.persistence.retryAt(`${rateKey}:cooldown`, now),
      mediaCooldown: this.options.persistence.retryAt(`${rateKey}:mediaCooldown`, now),
      invalid: false, queue: Promise.resolve(), nextRequest: 0
    };
    this.states.set(source, { rateKey, state });
    return { adapter: adapters[source], access: { key: credentials.key, tier }, scope, rateKey, state };
  }

  credentialsChanged(source: OnlineSource) { this.context(source).state.invalid = false; }

  status(): OnlineSourceStatus[] {
    return onlineSources.map(source => {
      const credentials = this.options.credentials(source);
      const { adapter, access, state } = this.context(source, credentials);
      const configured = Boolean(access.key || source === 'wikimedia');
      const waitUntil = Math.max(state.cooldown, state.mediaCooldown);
      const retryAt = waitUntil > this.now() ? waitUntil : undefined;
      return { source, types: adapter.types, configured, storedKey: Boolean(credentials.storedKey),
        automatic: adapter.automatic(access), tier: source === 'coverr' ? access.tier : undefined, retryAt,
        state: credentials.unavailable ? 'unavailable' : !configured ? 'missing' : state.invalid ? 'invalid' : retryAt ? 'cooldown' : 'ready' };
    });
  }

  private cooldown(source: SourceContext, ms: number, type: 'cooldown' | 'mediaCooldown' = 'cooldown') {
    const now = this.now();
    source.state[type] = Math.max(source.state[type], now + ms);
    this.options.persistence.recordCooldown(`${source.rateKey}:${type}`, now, source.state[type]);
  }

  private assertAvailable(source: SourceContext, checkCooldown = true) {
    if (source.state.invalid) throw new OnlineFailure('invalid');
    if (checkCooldown && source.state.cooldown > this.now()) throw new OnlineFailure('cooldown');
  }

  private queue<T>(source: SourceContext, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const task = source.state.queue.then(() => {
      signal.throwIfAborted();
      return action();
    });
    source.state.queue = task.then(() => undefined, () => undefined);
    return raceAbort(signal, task);
  }

  private async api<T>(source: SourceContext, signal: AbortSignal, run: (request: import('./adapter.js').ApiRequest) => Promise<T>) {
    this.assertAvailable(source);
    const name = source.adapter.source;
    if (name === 'wikimedia') {
      const delay = source.state.nextRequest - this.now();
      if (delay > 0) await setTimeout(delay, undefined, { signal });
      source.state.nextRequest = this.now() + 250;
    }
    const timeout = AbortSignal.timeout(12_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      return await run((url, init) => this.transport.api(name, url, init, combined, ms => this.cooldown(source, ms)));
    } catch (error) {
      signal.throwIfAborted();
      const failure = timeout.aborted ? new OnlineFailure('timeout') : safeFailure(error, 'network');
      if (failure.kind === 'invalid' && name !== 'wikimedia') source.state.invalid = true;
      if (failure.waitMs && source.state.cooldown <= this.now()) this.cooldown(source, failure.waitMs);
      throw failure;
    }
  }

  private searchSource({ source, provider }: SearchContext, signal: AbortSignal) {
    const key = createHash('sha256').update(JSON.stringify([source.scope, source.adapter.searchKey?.(provider) ?? provider])).digest('hex');
    return this.queue(source, signal, async () => {
      const now = this.now();
      this.assertAvailable(source, false);
      const persistent = source.adapter.source === 'pixabay';
      const entry = persistent ? undefined : this.cache.get(key);
      const cached = persistent ? this.options.persistence.readPixabay(key, now) : entry && entry.expires > now ? entry : undefined;
      if (cached) return cached;
      const result = await this.api(source, signal, request => source.adapter.search(provider, source.access, request));
      // Complete the 24-hour cache write even if the caller leaves after the response arrives.
      const expires = this.expiry(source.adapter);
      if (persistent) this.options.persistence.writePixabay(key, now, expires, result);
      else {
        if (this.cache.size >= 300) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires, page: result });
      }
      return { page: result, expires };
    });
  }

  private expiry(adapter: OnlineAdapter) {
    const now = this.now();
    return adapter.source === 'coverr' ? Math.min(now + adapter.cacheMs, (Math.floor(now / DAY) + 1) * DAY) : now + adapter.cacheMs;
  }

  private async visit<T>(request: OnlineSearchRequest, signal: AbortSignal, options: VisitOptions,
    use: (context: SearchContext, items: RemoteMedia[], hasMore: boolean, expires: number) => Promise<T | undefined>) {
    const failures: Failure[] = [];
    const start = options.after ? onlineSources.indexOf(options.after) + 1 : 0;
    for (const name of onlineSources.slice(start)) {
      signal.throwIfAborted();
      const credentials = this.options.credentials(name);
      const source = this.context(name, credentials);
      if ((!source.access.key && name !== 'wikimedia') || credentials.unavailable ||
          (options.automatic && !source.adapter.automatic(source.access))) continue;
      for (const type of new Set(request.types)) {
        if (!source.adapter.types.includes(type)) continue;
        const query = source.adapter.query(request.query);
        if (!query) continue;
        const provider = { type, query, page: request.page ?? 1, orientation: request.orientation };
        const context = { source, provider, request };
        try {
          if (source.state.mediaCooldown > this.now()) throw new OnlineFailure('cooldown');
          const { page: { items, hasMore }, expires } = await this.searchSource(context, signal);
          signal.throwIfAborted();
          const usable = items.filter(item => (!options.automatic || item.automatic) &&
            (item.type === 'image' || item.durationMs === undefined || item.durationMs >= (request.minDurationMs ?? 0)));
          const oriented = usable.filter(item => matchesOrientation(item, request.orientation));
          const canCrop = name === 'wikimedia' && (options.automatic || request.minDurationMs !== undefined);
          const value = await use(context, !oriented.length && canCrop ? usable : oriented, hasMore, expires);
          signal.throwIfAborted();
          if (value !== undefined) return { value, failures };
        } catch (error) {
          signal.throwIfAborted();
          const failure = safeFailure(error, 'network');
          failures.push([name, failure]);
          if (failure.kind === 'cooldown' || failure.kind === 'invalid' || failure.kind === 'timeout') break;
        }
      }
    }
    signal.throwIfAborted();
    return { failures };
  }

  private notice(failures: Failure[]) {
    return [...new Set(failures.map(([source, error]) => `${onlineSourceInfo[source].name}：${error.message}`))].join('；') || undefined;
  }

  async search(request: OnlineSearchRequest, signal: AbortSignal, after?: OnlineSource): Promise<OnlineSearchResult> {
    const { value, failures } = await this.visit(request, signal, { after }, async (context, items, hasMore, expires) => {
      if (!items.length) return;
      return { source: context.source.adapter.source, items: items.map(item => this.present(item, context, expires)),
        query: context.provider.query, page: context.provider.page, hasMore };
    });
    return value ?? { items: [], query: request.query, page: request.page ?? 1, hasMore: false, notice: this.notice(failures) };
  }

  private present(item: RemoteMedia, context: SearchContext, expires: number): OnlineAsset {
    const id = randomUUID();
    const source = context.source.adapter.source;
    if (this.handles.size >= 1500) this.handles.delete(this.handles.keys().next().value!);
    this.handles.set(id, { item, context, expires });
    const base = `voxweave-online://${id}`;
    return { id, source, type: item.type, name: item.name, thumbnailUrl: `${base}/thumbnail`, previewUrl: `${base}/preview`,
      license: item.license, width: item.width, height: item.height, durationMs: item.durationMs };
  }

  async preview(id: string, kind: 'thumbnail' | 'preview', request: Request) {
    const handle = this.handles.get(id);
    if (!handle) return new Response(null, { status: 404 });
    const { source } = handle.context;
    if (this.context(source.adapter.source).scope !== source.scope ||
        (['coverr', 'pixabay'].includes(source.adapter.source) && handle.expires <= this.now())) return new Response(null, { status: 404 });
    try {
      if (source.state.mediaCooldown > this.now()) return new Response(null, { status: 429 });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
      const result = await this.transport.media(source.adapter, handle.item[kind], signal, ms => this.cooldown(source, ms, 'mediaCooldown'), request.headers.get('range') ?? undefined);
      const headers = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' });
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = result.headers.get(header);
        if (value) headers.set(header, value);
      }
      return new Response(result.body, { status: result.status, headers });
    } catch { return new Response(null, { status: 502 }); }
  }

  private async download(context: SearchContext, item: RemoteMedia, signal: AbortSignal) {
    const { source, request } = context;
    signal.throwIfAborted();
    this.assertAvailable(source, Boolean(source.adapter.trackDownload));
    if (source.state.mediaCooldown > this.now()) throw new OnlineFailure('cooldown');
    let filePath: string | undefined;
    try {
      filePath = await this.transport.download(source.adapter, item, this.options.directory, signal, ms => this.cooldown(source, ms, 'mediaCooldown'));
      if (source.adapter.trackDownload) {
        const track = source.adapter.trackDownload;
        await this.queue(source, signal, () => this.api(source, signal, send => track(item, source.access, send)));
      }
      signal.throwIfAborted();
      const asset = await this.options.importMedia(item, filePath, request.minDurationMs ?? 0, signal);
      if (asset.filePath !== filePath) await rm(filePath, { force: true });
      return asset;
    } catch (error) {
      if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
      signal.throwIfAborted();
      throw safeFailure(error, 'download');
    }
  }

  async downloadSelected(id: string, signal: AbortSignal): Promise<OnlineDownloadResult> {
    const handle = this.handles.get(id);
    if (!handle) throw new Error('搜索结果已过期，请重新搜索');
    const { context, item } = handle;
    const name = context.source.adapter.source;
    try {
      if (this.context(name).scope !== context.source.scope) throw new OnlineFailure('invalid');
      let current: RemoteMedia | undefined = item;
      if ((name === 'coverr' || name === 'pixabay') && handle.expires <= this.now())
        current = (await this.searchSource(context, signal)).page.items.find(candidate => candidate.id === item.id);
      if (!current) throw new OnlineFailure('download');
      return { asset: await this.download(context, current, signal) };
    } catch (error) {
      signal.throwIfAborted();
      const alternatives = await this.search({ ...context.request, page: 1 }, signal, name);
      const failure = `${onlineSourceInfo[name].name}：${safeFailure(error, 'download').message}`;
      return { alternatives: { ...alternatives, notice: [failure, alternatives.notice].filter(Boolean).join('；') } };
    }
  }

  async acquire(request: OnlineSearchRequest, remainingMs: number, excluded: Set<string>, signal: AbortSignal):
    Promise<{ asset?: MediaAsset; notice?: string }> {
    const { value, failures } = await this.visit(request, signal, { automatic: true }, async (context, items) => {
      const ranked = items.filter(item => item.license.sourceUrl && !excluded.has(item.license.sourceUrl))
        .sort((a, b) => Number((a.durationMs ?? 0) < remainingMs) - Number((b.durationMs ?? 0) < remainingMs));
      let failure: unknown;
      for (const item of ranked.slice(0, 3)) {
        excluded.add(item.license.sourceUrl!);
        try { return await this.download(context, item, signal); }
        catch (error) {
          signal.throwIfAborted();
          failure = error;
          if (error instanceof OnlineFailure && ['cooldown', 'invalid'].includes(error.kind)) break;
          if (context.source.state.mediaCooldown > this.now()) break;
        }
      }
      if (failure) throw failure;
    });
    return { asset: value, notice: value ? undefined : this.notice(failures) };
  }
}
