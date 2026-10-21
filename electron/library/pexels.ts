import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PexelsSearchSchema, type OnlineAsset } from '../../shared/library.js';
import { englishSearchQuery, expandKeywords } from '../../shared/keywords.js';

const Photo = z.object({ id: z.number(), width: z.number(), height: z.number(), url: z.string().url(),
  photographer: z.string(), alt: z.string().default(''), src: z.object({ medium: z.string().url(), large2x: z.string().url() }) });
const Video = z.object({ id: z.number(), width: z.number(), height: z.number(), url: z.string().url(),
  image: z.string().url(), duration: z.number(), user: z.object({ name: z.string() }),
  video_files: z.array(z.object({ file_type: z.string(), width: z.number().nullable(), height: z.number().nullable(), link: z.string().url() })) });

export function assertPexelsUrl(value: string, kind: 'media' | 'page' = 'media'): string {
  const url = new URL(value);
  const hosts = kind === 'media' ? ['images.pexels.com', 'videos.pexels.com'] : ['www.pexels.com', 'pexels.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) throw new Error('素材来源地址不受支持');
  return value;
}

export class PexelsClient {
  private readonly results = new Map<string, OnlineAsset>();
  private readonly cache = new Map<string, { expires: number; items: OnlineAsset[] }>();
  constructor(private readonly apiKey: () => string, private readonly request: typeof fetch = fetch) {}

  async search(input: z.input<typeof PexelsSearchSchema>, signal?: AbortSignal): Promise<{ items: OnlineAsset[]; query: string }> {
    signal?.throwIfAborted();
    const parsed = PexelsSearchSchema.parse(input);
    const query = englishSearchQuery(parsed.query);
    const cacheKey = JSON.stringify({ ...parsed, query });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return { items: cached.items, query };
    const key = this.apiKey();
    if (!key) throw new Error('请先在素材库设置 Pexels API Key');
    const url = new URL(parsed.type === 'image' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/v1/videos/search');
    url.search = new URLSearchParams({ query, per_page: '12', page: String(parsed.page), ...(parsed.orientation ? { orientation: parsed.orientation } : {}) }).toString();
    const response = await this.request(url, { headers: { Authorization: key }, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 429 ? 'Pexels 请求额度已用完，请稍后再试' : response.status === 401 || response.status === 403 ? 'Pexels API Key 无效或没有访问权限' : `Pexels 搜索失败（${response.status}）`);
    const data: unknown = await response.json();
    const items: OnlineAsset[] = parsed.type === 'image'
      ? z.object({ photos: z.array(Photo) }).parse(data).photos.map(photo => ({
        id: `pexels-image-${photo.id}`, type: 'image', name: photo.alt || `Pexels ${photo.id}`, thumbnailUrl: photo.src.medium,
        sourceUrl: photo.url, downloadUrl: photo.src.large2x, author: photo.photographer, width: photo.width, height: photo.height,
        tags: expandKeywords(`${parsed.query} ${photo.alt}`).slice(0, 50)
      }))
      : z.object({ videos: z.array(Video) }).parse(data).videos.flatMap(video => {
        const files = video.video_files.filter(file => file.file_type === 'video/mp4' && file.width && file.height);
        const preferred = files.filter(file => Math.max(file.width!, file.height!) <= 1920);
        const file = (preferred.length ? preferred.sort((a, b) => b.width! * b.height! - a.width! * a.height!) : files.sort((a, b) => a.width! * a.height! - b.width! * b.height!))[0];
        return file ? [{ id: `pexels-video-${video.id}`, type: 'video' as const, name: `${parsed.query} · ${video.id}`,
          thumbnailUrl: video.image, sourceUrl: video.url, downloadUrl: file.link, author: video.user.name,
          width: file.width!, height: file.height!, durationMs: Math.round(video.duration * 1000), tags: expandKeywords(parsed.query).slice(0, 50) }] : [];
      });
    for (const item of items) {
      assertPexelsUrl(item.sourceUrl, 'page'); assertPexelsUrl(item.thumbnailUrl); assertPexelsUrl(item.downloadUrl);
      this.results.set(item.id, item);
    }
    if (this.cache.size > 100) this.cache.clear();
    if (this.results.size > 1500) { this.results.clear(); for (const item of items) this.results.set(item.id, item); }
    this.cache.set(cacheKey, { expires: Date.now() + 5 * 60_000, items });
    return { items, query };
  }

  async download(id: string, directory: string, signal?: AbortSignal): Promise<{ item: OnlineAsset; filePath: string }> {
    const item = this.results.get(id);
    if (!item) throw new Error('搜索结果已过期，请重新搜索');
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${item.id}-${randomUUID()}${item.type === 'video' ? '.mp4' : '.jpg'}`);
    const temporary = `${filePath}.part`;
    const controller = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
    const response = await this.request(assertPexelsUrl(item.downloadUrl), { signal: controller, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`素材下载失败（${response.status}）`);
    const maxBytes = 500 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('素材超过 500 MB，请选择更小的素材'); }
    const file = await open(temporary, 'wx');
    let closed = false;
    try {
      let bytes = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw new Error('素材超过 500 MB');
        await file.writeFile(chunk);
      }
      if (!bytes) throw new Error('下载的素材为空');
      await file.close(); closed = true;
      await rename(temporary, filePath);
      return { item, filePath };
    } finally { if (!closed) await file.close(); await rm(temporary, { force: true }); }
  }
}
