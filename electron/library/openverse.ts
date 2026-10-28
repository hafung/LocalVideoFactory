import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MusicSearchSchema, type MusicSearchRequest, type MusicSearchResult, type OnlineMusic, type AssetLicense } from '../../shared/library.js';
import { englishSearchQuery, expandKeywords } from '../../shared/keywords.js';

const API = 'https://api.openverse.org/v1/audio/';
const MAX_BYTES = 100 * 1024 * 1024;
const formats = new Set(['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac']);
const Audio = z.object({
  id: z.string().uuid(), title: z.string().nullable(), creator: z.string().nullable(),
  foreign_landing_url: z.string().url(), url: z.string().url(),
  license: z.string(), license_version: z.string().nullable(), license_url: z.string().url(),
  provider: z.string(), duration: z.number().positive(), filetype: z.string().nullable(),
  attribution: z.string().default(''), tags: z.array(z.object({ name: z.string() })).default([]),
  mature: z.boolean().default(false)
});
type StoredMusic = { item: OnlineMusic; extension: string; expires: number };

// Only known Openverse audio providers may supply downloads or preview URLs.
export function assertMusicUrl(value: string, kind: 'media' | 'page' = 'media'): string {
  const url = new URL(value);
  const hosts = kind === 'media'
    ? ['cdn.freesound.org', 'freesound.org', 'upload.wikimedia.org', 'mp3d.jamendo.com', 'prod-1.storage.jamendo.com']
    : ['openverse.org', 'freesound.org', 'www.freesound.org', 'jamendo.com', 'www.jamendo.com', 'commons.wikimedia.org', 'creativecommons.org'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new Error('音乐来源地址不受支持');
  }
  return value;
}

function mapAudio(value: unknown, allowBy: boolean): StoredMusic | undefined {
  const parsed = Audio.safeParse(value);
  if (!parsed.success) return;
  const audio = parsed.data;
  if (audio.mature || audio.duration < 10_000 || !['cc0', ...(allowBy ? ['by'] : [])].includes(audio.license)) return;
  const license = audio.license as OnlineMusic['license'];
  const version = audio.license_version ?? (license === 'cc0' ? '1.0' : '');
  if (license === 'cc0' ? version !== '1.0' : !['1.0', '2.0', '2.5', '3.0', '4.0'].includes(version)) return;
  const licenseUrl = license === 'cc0' ? 'https://creativecommons.org/publicdomain/zero/1.0/' : `https://creativecommons.org/licenses/by/${version}/`;
  // A contradictory license URL must never be presented as CC0 or CC BY.
  if (audio.license_url.replace(/^http:/u, 'https:').replace(/\/$/u, '') !== licenseUrl.replace(/\/$/u, '')) return;
  try { assertMusicUrl(audio.url); assertMusicUrl(audio.foreign_landing_url, 'page'); } catch { return; }
  const suffix = path.posix.extname(new URL(audio.url).pathname).slice(1).toLowerCase();
  const extension = formats.has(suffix) ? suffix : audio.filetype?.toLowerCase();
  if (!extension || !formats.has(extension)) return;
  return { extension, expires: Date.now() + 30 * 60_000, item: {
    id: audio.id, name: audio.title || '未命名音乐', author: audio.creator || '未署名作者', provider: audio.provider,
    sourceUrl: audio.foreign_landing_url, previewUrl: audio.url, durationMs: Math.round(audio.duration),
    license, licenseVersion: version, licenseUrl, attribution: audio.attribution,
    tags: [...new Set(['背景音乐', 'music', ...audio.tags.map(tag => tag.name.trim()).filter(Boolean)])].slice(0, 50)
  } };
}

export function musicLicense(item: OnlineMusic): AssetLicense {
  return { status: 'licensed', source: 'openverse', sourceUrl: item.sourceUrl, author: item.author, licenseUrl: item.licenseUrl,
    note: `${item.license === 'cc0' ? 'CC0' : 'CC BY'} ${item.licenseVersion} · ${item.provider}\n${item.attribution || `“${item.name}” — ${item.author}. ${item.sourceUrl} · ${item.licenseUrl}`}` };
}

export class OpenverseClient {
  private readonly results = new Map<string, StoredMusic>();
  private readonly cache = new Map<string, { expires: number; result: MusicSearchResult }>();
  constructor(private readonly request: typeof fetch = fetch) {}

  private async json(url: URL | string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, { signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), redirect: 'error' });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error('无法连接 Openverse，请检查网络后重试', { cause: error });
    }
    if (!response.ok) {
      throw new Error(response.status === 429 ? 'Openverse 请求较多，请稍后再试' : `Openverse 请求失败（${response.status}），请稍后重试`);
    }
    return response.json();
  }

  async search(value: MusicSearchRequest, signal?: AbortSignal): Promise<MusicSearchResult> {
    signal?.throwIfAborted();
    const input = MusicSearchSchema.parse(value);
    const translated = englishSearchQuery(input.query);
    const query = /\bmusic\b/iu.test(translated) ? translated : `${translated} music`;
    const key = JSON.stringify({ ...input, query });
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    const url = new URL(API);
    // Freesound music often has category=null. Search music keywords instead of excluding those tracks.
    url.search = new URLSearchParams({ q: query, license: input.license === 'cc0' ? 'cc0' : 'cc0,by',
      page: String(input.page), page_size: '12', length: 'short,medium,long', mature: 'false', filter_dead: 'true' }).toString();
    const data = z.object({ results: z.array(z.unknown()), page_count: z.number().int().nonnegative(), page: z.number().int().positive() }).parse(await this.json(url, signal));
    const tracks = data.results.flatMap(row => { const track = mapAudio(row, input.license === 'cc0-by'); return track ? [track] : []; });
    for (const [id, track] of this.results) if (track.expires < Date.now()) this.results.delete(id);
    for (const track of tracks) this.results.set(track.item.id, track);
    while (this.results.size > 1500) this.results.delete(this.results.keys().next().value!);
    const result = { items: tracks.map(track => ({ ...track.item, tags: [...new Set([...track.item.tags, ...expandKeywords(input.query)])].slice(0, 50) })),
      query, page: data.page, pageCount: Math.min(data.page_count, 100) };
    if (this.cache.size >= 100) this.cache.clear();
    this.cache.set(key, { expires: Date.now() + 5 * 60_000, result });
    return result;
  }

  async download(id: string, directory: string, signal?: AbortSignal): Promise<{ item: OnlineMusic; filePath: string }> {
    const searched = this.results.get(id);
    if (!searched || searched.expires < Date.now()) throw new Error('音乐搜索结果已过期，请重新搜索');
    // Recheck the current record rather than trusting license metadata from an old search.
    const track = mapAudio(await this.json(`${API}${z.string().uuid().parse(id)}/`, signal), searched.item.license === 'by');
    if (!track || track.item.id !== id || track.item.licenseUrl !== searched.item.licenseUrl) throw new Error('音乐信息或许可已变更，请重新搜索');
    const controller = AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]);
    let url = track.item.previewUrl;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await this.request(assertMusicUrl(url), { signal: controller, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('音乐下载重定向失败');
      url = assertMusicUrl(new URL(location, url).href);
    }
    if (!response?.ok || !response.body) throw new Error(`音乐下载失败（${response?.status}）`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('audio/') && !['application/ogg', 'application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
      await response.body.cancel(); throw new Error('下载地址没有返回音频，请选择其他音乐');
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel(); throw new Error('音乐超过 100 MB，请选择较小的文件');
    }
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `openverse-${id}-${randomUUID()}.${track.extension}`);
    const temporary = `${filePath}.part`;
    const file = await open(temporary, 'wx');
    try {
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error('音乐超过 100 MB');
        await file.writeFile(chunk);
      }
      if (!bytes) throw new Error('下载的音乐为空');
      await file.close();
      await rename(temporary, filePath);
      return { item: track.item, filePath };
    } finally { await file.close(); await rm(temporary, { force: true }); }
  }
}
