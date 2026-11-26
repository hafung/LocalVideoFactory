import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDraftEditPlan } from '../../../shared/edit-plan.js';
import type { OnlineSearchRequest, OnlineSource } from '../../../shared/library.js';
import { resolveEditPlan } from '../../composition/resolver.js';
import { fillOnlineMedia } from '../automatic-media.js';
import { LibraryDatabase } from '../database.js';
import { AssetImporter } from '../importer.js';
import { DAY } from './adapter.js';
import { OnlineMediaCache } from './cache.js';
import { OnlineMediaService, type SourceCredentials } from './service.js';

const pexels = { photos: [{
  id: 101, width: 800, height: 600, url: 'https://www.pexels.com/photo/101/', photographer: 'Pexels Author',
  src: { medium: 'https://images.pexels.com/a-thumb.jpg', large2x: 'https://images.pexels.com/a.jpg' }
}] };
const pixabay = { totalHits: 31, hits: [{
  id: 201, tags: 'beach, waves', pageURL: 'https://pixabay.com/photos/beach-201/', user: 'Pixabay Author', user_id: 2,
  webformatURL: 'https://cdn.pixabay.com/small.jpg', largeImageURL: 'https://pixabay.com/get/full.jpg', imageWidth: 800, imageHeight: 600
}] };
const coverrVideo = {
  id: 'coverr-clip', title: 'Coverr beach', slug: 'beach-coverr-clip', duration: 6, max_width: 800, max_height: 600, is_premium: true,
  thumbnail: 'https://storage.coverr.co/thumb?token=secret-media', creator: { name: 'Coverr Creator', profile_url: 'https://coverr.co/creator/test' },
  urls: { mp4: 'https://storage.coverr.co/video?token=secret-media', mp4_preview: 'https://storage.coverr.co/preview?token=secret-media',
    mp4_download: 'https://storage.coverr.co/video/download?token=secret-media' }
};
function commons(license = 'https://creativecommons.org/publicdomain/zero/1.0/', video = false) {
  return { query: { pages: [{
    title: video ? 'File:Beach.ogv' : 'File:Beach.png', index: 1, [video ? 'videoinfo' : 'imageinfo']: [{
      url: `https://upload.wikimedia.org/original.${video ? 'ogv' : 'png'}`, thumburl: 'https://thumb.wikimedia.org/thumb.png',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Beach.png', user: 'Uploader', width: 800, height: 600,
      mime: video ? 'application/ogg' : 'image/png', ...(video ? { duration: 5, derivatives: [
        { src: 'https://upload.wikimedia.org/beach.m3u8', type: 'application/vnd.apple.mpegurl' },
        { src: 'https://upload.wikimedia.org/beach-small.webm', type: 'video/webm; codecs="vp9, opus"', width: 400, height: 300 },
        { src: 'https://upload.wikimedia.org/beach-large.webm', type: 'video/webm; codecs="vp9, opus"', width: 800, height: 600 }
      ] } : {}), extmetadata: {
        Artist: { value: '<a href="/wiki/User:Creator">Creator &amp; Team</a>' },
        LicenseShortName: { value: license.includes('zero') ? 'CC0' : 'CC BY-SA 4.0' }, LicenseUrl: { value: license }
      }
    }]
  }] } };
}
const request: OnlineSearchRequest = { query: 'beach', types: ['image'] };
const signal = () => new AbortController().signal;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function fixture(fetcher: typeof fetch, credentials: Partial<Record<OnlineSource, SourceCredentials>> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameskiff-online-'));
  const file = path.join(directory, 'test.sqlite');
  const downloads = path.join(directory, 'downloads');
  let db = new LibraryDatabase(file);
  let now = Date.now();
  function service() {
    const importer = new AssetImporter(db, { probe: async () => ({ hasAudio: false, width: 800, height: 600, durationMs: 5000 }) }, directory);
    return new OnlineMediaService({
      fetch: fetcher, now: () => now, credentials: source => credentials[source] ?? { key: '' },
      persistence: new OnlineMediaCache(db.sqlite), directory: downloads,
      importMedia: (item, filePath, minDurationMs, abort) => importer.import({ filePath, license: item.license, tags: item.tags },
        { name: item.name, type: item.type, minDurationMs, signal: abort })
    });
  }
  const first = service();
  cleanup.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { first, downloads, advance: (ms: number) => { now += ms; }, db: () => db,
    restart: () => { db.close(); db = new LibraryDatabase(file); return service(); } };
}
const hosts = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname);

it('searches Commons without a key and persists attribution and the actual file format', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(commons('https://creativecommons.org/licenses/by-sa/4.0/')))
    .mockResolvedValueOnce(new Response('png bytes', { headers: { 'Content-Type': 'image/png' } }));
  const { first, db } = await fixture(fetcher);
  const found = await first.search(request, signal());
  expect(found.source).toBe('wikimedia');
  expect(hosts(fetcher)).toEqual(['commons.wikimedia.org']);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('User-Agent')).toContain('FrameSkiff');
  const downloaded = await first.downloadSelected(found.items[0].id, signal());
  expect(downloaded).toHaveProperty('asset');
  expect(db().list()[0]).toMatchObject({ name: 'Beach', license: { source: 'wikimedia', author: 'Creator & Team',
    authorUrl: 'https://commons.wikimedia.org/wiki/User:Creator', licenseName: 'CC BY-SA 4.0', attributionRequired: true,
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Beach.png' } });
  expect(db().list()[0].filePath).toMatch(/\.png$/u);
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
});

it('stops at the first usable source with multiple keys, while preserving search caching', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(pexels));
  const { first } = await fixture(fetcher, { pexels: { key: 'p' }, pixabay: { key: 'b' }, coverr: { key: 'c' } });
  expect((await first.search(request, signal())).source).toBe('pexels');
  expect((await first.search(request, signal())).source).toBe('pexels');
  expect(hosts(fetcher)).toEqual(['api.pexels.com']);
});

it.each([200, 401, 403, 429])('falls back on HTTP %s or an empty response and keeps secrets out of status and UI', async status => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(status === 200 ? Response.json({ photos: [] }) : new Response('contains PRIVATE_KEY', { status, headers: { 'Retry-After': '120' } }))
    .mockResolvedValueOnce(Response.json(pixabay));
  const { first, advance, restart } = await fixture(fetcher, { pexels: { key: 'PRIVATE_KEY' }, pixabay: { key: 'another-key' } });
  expect((await first.search(request, signal())).source).toBe('pixabay');
  expect(hosts(fetcher)).toEqual(['api.pexels.com', 'pixabay.com']);
  if (status !== 200) {
    const states = first.status();
    expect(JSON.stringify(states)).not.toContain('PRIVATE_KEY');
    expect(states[0].state).toBe(status === 429 ? 'cooldown' : 'invalid');
    expect((await first.search({ ...request, query: 'next beach' }, signal())).notice).not.toContain('PRIVATE_KEY');
    expect(hosts(fetcher).filter(host => host === 'api.pexels.com')).toHaveLength(1);
  }
  if (status === 429) {
    advance(119_999);
    const restarted = restart();
    expect(restarted.status()[0].state).toBe('cooldown');
    expect((await restarted.search(request, signal())).source).toBe('pixabay');
    expect(hosts(fetcher).filter(host => host === 'api.pexels.com')).toHaveLength(1);
    advance(1);
    fetcher.mockResolvedValueOnce(Response.json(pexels));
    expect((await restarted.search({ ...request, query: 'other beach' }, signal())).source).toBe('pexels');
  }
});

it('honors absolute Retry-After and lets the last successful API response download from the separate CDN', async () => {
  const reset = Math.ceil(Date.now() / 1000) + 120;
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(pexels, { headers: {
      'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(reset), 'Retry-After': new Date((reset + 30) * 1000).toUTCString()
    } })).mockResolvedValueOnce(new Response('image', { headers: { 'Content-Type': 'image/jpeg' } }));
  const { first } = await fixture(fetcher, { pexels: { key: 'x' } });
  const found = await first.search(request, signal());
  expect(first.status()[0]).toMatchObject({ state: 'cooldown', retryAt: (reset + 30) * 1000 });
  expect(await first.downloadSelected(found.items[0].id, signal())).toHaveProperty('asset');
  expect(hosts(fetcher)).toEqual(['api.pexels.com', 'images.pexels.com']);
});

it('falls back after a timed out request and stops immediately when cancelled', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new DOMException('secret URL', 'TimeoutError'))
    .mockResolvedValueOnce(Response.json(commons()));
  const { first } = await fixture(fetcher, { pexels: { key: 'x' } });
  expect((await first.search(request, signal())).source).toBe('wikimedia');
  const controller = new AbortController();
  fetcher.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const pending = first.search({ ...request, query: 'new query' }, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  controller.abort();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([pixabay, { hits: [], totalHits: 0 }])('persists positive and empty Pixabay responses for 24 hours across restarts', async page => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url =>
    new URL(String(url)).hostname === 'pixabay.com' ? Response.json(page) : Response.json(commons()));
  const { first, restart, advance, db } = await fixture(fetcher, { pixabay: { key: 'PRIVATE_KEY' } });
  await first.search(request, signal());
  const next = restart();
  advance(DAY - 1);
  await next.search({ ...request, orientation: 'square' }, signal());
  expect(hosts(fetcher).filter(host => host === 'pixabay.com')).toHaveLength(1);
  expect(JSON.stringify(db().sqlite.prepare('SELECT * FROM pixabay_search_cache').all())).not.toContain('PRIVATE_KEY');
  advance(1);
  await next.search(request, signal());
  expect(hosts(fetcher).filter(host => host === 'pixabay.com')).toHaveLength(2);
});

it('sanitizes network failures and returns alternatives when the explicitly selected download fails', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(pexels))
    .mockRejectedValueOnce(new Error('credential and URL contents')).mockResolvedValueOnce(Response.json(pixabay));
  const { first, db, downloads } = await fixture(fetcher, { pexels: { key: 'x' }, pixabay: { key: 'y' } });
  const found = await first.search(request, signal());
  const result = await first.downloadSelected(found.items[0].id, signal());
  expect(result).toMatchObject({ alternatives: { source: 'pixabay', notice: 'Pexels：下载或导入失败' } });
  expect(db().list()).toEqual([]);
  expect(await readdir(downloads)).toEqual([]);
});

it('shows Coverr attribution in Demo, keeps media tokens private, and tracks imports exactly once', async () => {
  const clip = { ...coverrVideo, is_premium: false };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ hits: [clip], pages: 1 }))
    .mockResolvedValueOnce(new Response('preview', { headers: { 'Content-Type': 'video/mp4' } }))
    .mockResolvedValueOnce(new Response('video', { headers: { 'Content-Type': 'video/mp4' } }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const { first, db } = await fixture(fetcher, { coverr: { key: 'x', tier: 'demo' } });
  const found = await first.search({ ...request, types: ['video'], minDurationMs: 4000 }, signal());
  expect(found.source).toBe('coverr');
  expect(found.items[0].license).toMatchObject({ author: 'Coverr Creator', attributionRequired: true });
  expect(JSON.stringify(found)).not.toContain('secret-media');
  const item = found.items[0];
  const preview = await first.preview(item.id, 'preview', new Request(item.previewUrl, { headers: { Range: 'bytes=0-10' } }));
  expect(await preview.text()).toBe('preview');
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('range')).toBe('bytes=0-10');
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).has('x-api-key')).toBe(false);
  await first.downloadSelected(item.id, signal());
  expect(String(fetcher.mock.calls[3][0])).toBe('https://api.coverr.co/videos/coverr-clip/stats/downloads');
  expect(fetcher.mock.calls[3][1]?.method).toBe('PATCH');
  expect(db().list()[0].license.source).toBe('coverr');
});

it.each(['demo', 'production', 'enterprise'] as const)('uses the automatic sources permitted for a %s Coverr key', async tier => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (value, init) => {
    const { hostname } = new URL(String(value));
    if (init?.method === 'PATCH') return new Response(null, { status: 204 });
    if (hostname === 'api.pexels.com') return Response.json({ videos: [] });
    if (hostname === 'api.coverr.co') return Response.json({ hits: [coverrVideo], pages: 1 });
    if (hostname === 'commons.wikimedia.org') return Response.json(commons('http://creativecommons.org/publicdomain/zero/1.0/deed.en', true));
    return new Response('video', { headers: { 'Content-Type': 'video/mp4' } });
  });
  const { first, db } = await fixture(fetcher, { pexels: { key: 'p' }, pixabay: { key: 'b' }, coverr: { key: 'c', tier } });
  const draft = createDraftEditPlan({ id: 'automatic', script: '沙滩。', voiceId: 'vivian' });
  draft.scenes[0].visual.intent.searchQuery = 'beach';
  draft.scenes[0].visual.intent.orientation = 'landscape';
  const plan = resolveEditPlan(draft, { narration: { audioPath: '/voice.wav', durationMs: 4000,
    segments: [{ id: 'scene-001', text: '沙滩。', startMs: 0, endMs: 4000 }] } });
  const result = await fillOnlineMedia(plan, first, signal(), () => {});
  expect(result.scenes[0].visual).toMatchObject({ type: 'video', assetId: db().list()[0].id });
  expect(hosts(fetcher)).not.toContain('pixabay.com');
  expect(hosts(fetcher).includes('api.coverr.co')).toBe(tier !== 'demo');
  expect(db().list()[0].license.source).toBe(tier === 'demo' ? 'wikimedia' : 'coverr');
  if (tier === 'demo') {
    const url = new URL(String(fetcher.mock.calls.find(([input]) => String(input).startsWith('https://commons.wikimedia.org'))?.[0]));
    expect(url.searchParams.get('prop')).toBe('videoinfo');
    expect(fetcher.mock.calls.map(([input]) => String(input))).toContain('https://upload.wikimedia.org/beach-large.webm');
    expect(db().list()[0].filePath).toMatch(/\.webm$/u);
  }
});

it('skips incompatible types and Commons licenses with attribution obligations in automatic selection', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(commons('https://creativecommons.org/licenses/by-sa/4.0/')));
  const { first } = await fixture(fetcher, { coverr: { key: 'x', tier: 'production' } });
  expect(await first.acquire(request, 1000, new Set(), signal())).not.toHaveProperty('asset.id');
  expect(hosts(fetcher)).toEqual(['commons.wikimedia.org']);
});

it('acquires a Commons asset automatically after the preferred source media download fails', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(pexels))
    .mockResolvedValueOnce(new Response('', { status: 502 }))
    .mockResolvedValueOnce(Response.json(commons()))
    .mockResolvedValueOnce(new Response('actual media', { headers: { 'Content-Type': 'image/png' } }));
  const { first, db } = await fixture(fetcher, { pexels: { key: 'x' }, pixabay: { key: 'y' } });
  expect(await first.acquire(request, 1000, new Set(), signal())).toHaveProperty('asset.license.source', 'wikimedia');
  expect(hosts(fetcher)).toEqual(['api.pexels.com', 'images.pexels.com', 'commons.wikimedia.org', 'upload.wikimedia.org']);
  expect(db().list()).toHaveLength(1);
});

it('does not query or import another source after cancelling a download', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(pexels))
    .mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
  const { first, db } = await fixture(fetcher, { pexels: { key: 'x' }, pixabay: { key: 'b' } });
  const found = await first.search(request, signal());
  const controller = new AbortController();
  const pending = first.downloadSelected(found.items[0].id, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  controller.abort();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(db().list()).toEqual([]);
});
