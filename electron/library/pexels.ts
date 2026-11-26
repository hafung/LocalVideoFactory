import { z } from 'zod';
import { englishSearchQuery, expandKeywords } from '../../shared/keywords.js';
import { durationMs, httpsUrl, itemFrom, PAGE_SIZE, searchText, type OnlineAdapter } from './online/adapter.js';

const Photo = z.object({ id: z.number(), width: z.number(), height: z.number(), url: z.string(),
  photographer: z.string(), photographer_url: z.string().optional(), alt: z.string().nullish(),
  src: z.object({ medium: z.string(), large2x: z.string() }) });
const Video = z.object({ id: z.number(), url: z.string(), image: z.string(), duration: z.number(),
  user: z.object({ name: z.string(), url: z.string().optional() }),
  video_files: z.array(z.object({ file_type: z.string(), width: z.number().nullish(), height: z.number().nullish(), link: z.string() })) });

const mediaUrl = (value: string) => httpsUrl(value, ['images.pexels.com', 'videos.pexels.com', 'player.vimeo.com']);
const pageUrl = (value: unknown) => httpsUrl(value, ['www.pexels.com', 'pexels.com']);
const license = (sourceUrl: string, author: string, authorUrl?: string) => ({
  status: 'licensed' as const, source: 'pexels', sourceUrl, author, authorUrl,
  licenseName: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/'
});

export const pexelsAdapter: OnlineAdapter = {
  source: 'pexels', types: ['video', 'image'], cacheMs: 5 * 60_000, mediaUrl,
  query: value => englishSearchQuery(searchText(value)),
  automatic: () => true,
  async search(input, { key }, request) {
    const url = new URL(input.type === 'image' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/v1/videos/search');
    url.search = new URLSearchParams({ query: input.query, per_page: String(PAGE_SIZE), page: String(input.page),
      ...(input.orientation ? { orientation: input.orientation } : {}) }).toString();
    const data: unknown = await (await request(url, { headers: { Authorization: key } })).json();
    const page = z.object({ photos: z.array(z.unknown()).optional(), videos: z.array(z.unknown()).optional(), next_page: z.string().nullish() }).parse(data);
    const tags = expandKeywords(input.query).slice(0, 50);
    const items = input.type === 'image' ? (page.photos ?? []).flatMap(value => {
      const row = Photo.safeParse(value);
      if (!row.success) return [];
      const photo = row.data;
      const source = pageUrl(photo.url), thumbnail = mediaUrl(photo.src.medium), download = mediaUrl(photo.src.large2x);
      if (!source || !thumbnail || !download) return [];
      return itemFrom({ id: String(photo.id), type: 'image', name: photo.alt || `Pexels ${photo.id}`,
        thumbnail, preview: thumbnail, download, extension: '.jpg', license: license(source, photo.photographer, pageUrl(photo.photographer_url)),
        width: photo.width, height: photo.height, automatic: true, tags: expandKeywords(`${input.query} ${photo.alt ?? ''}`).slice(0, 50) });
    }) : (page.videos ?? []).flatMap(value => {
      const row = Video.safeParse(value);
      if (!row.success) return [];
      const video = row.data;
      const source = pageUrl(video.url), thumbnail = mediaUrl(video.image);
      const files = video.video_files.flatMap(file => {
        const link = mediaUrl(file.link);
        return file.file_type === 'video/mp4' && file.width && file.height && link ? [{ width: file.width, height: file.height, link }] : [];
      }).sort((a, b) => a.width * a.height - b.width * b.height);
      const file = files.filter(candidate => Math.max(candidate.width, candidate.height) <= 1920).at(-1) ?? files[0];
      if (!source || !thumbnail || !file) return [];
      return itemFrom({ id: String(video.id), type: 'video', name: `${input.query} · ${video.id}`, thumbnail,
        preview: files[0].link, download: file.link, extension: '.mp4', width: file.width, height: file.height,
        durationMs: durationMs(video.duration), automatic: true, tags, license: license(source, video.user.name, pageUrl(video.user.url)) });
    });
    return { items, hasMore: Boolean(page.next_page) };
  }
};
