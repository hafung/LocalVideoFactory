import { z } from 'zod';
import { englishSearchQuery, expandKeywords } from '../../../shared/keywords.js';
import { DAY, durationMs, httpsUrl, itemFrom, PAGE_SIZE, searchText, type OnlineAdapter } from './adapter.js';

const rendition = z.object({ url: z.string(), width: z.number(), height: z.number(), thumbnail: z.string().optional() });
const hit = z.object({ id: z.number(), pageURL: z.string(), user: z.string(), user_id: z.number().optional(), tags: z.string(),
  previewURL: z.string().optional(), webformatURL: z.string().optional(), largeImageURL: z.string().optional(),
  fullHDURL: z.string().optional(), imageWidth: z.number().optional(), imageHeight: z.number().optional(),
  duration: z.number().optional(), videos: z.record(z.string(), rendition).optional() });

const mediaUrl = (value: unknown) => httpsUrl(value, ['pixabay.com', 'cdn.pixabay.com', 'images.pixabay.com']);
const pageUrl = (value: unknown) => httpsUrl(value, ['pixabay.com', 'www.pixabay.com']);

export const pixabayAdapter: OnlineAdapter = {
  source: 'pixabay', types: ['video', 'image'], cacheMs: DAY,
  mediaUrl, query: value => Array.from(englishSearchQuery(searchText(value))).slice(0, 100).join(''),
  searchKey: input => ({ ...input, orientation: input.type === 'image' && input.orientation !== 'square' ? input.orientation : undefined }),
  automatic: () => false,
  async search(input, { key }, request) {
    const url = new URL(input.type === 'video' ? 'https://pixabay.com/api/videos/' : 'https://pixabay.com/api/');
    url.search = new URLSearchParams({ key, q: input.query, safesearch: 'true', page: String(input.page), per_page: String(PAGE_SIZE) }).toString();
    if (input.type === 'image') {
      url.searchParams.set('image_type', 'photo');
      if (input.orientation === 'portrait' || input.orientation === 'landscape')
        url.searchParams.set('orientation', input.orientation === 'portrait' ? 'vertical' : 'horizontal');
    }
    const page = z.object({ hits: z.array(z.unknown()), totalHits: z.number() }).parse(await (await request(url)).json());
    const items = page.hits.flatMap(value => {
      const row = hit.safeParse(value);
      if (!row.success) return [];
      const data = row.data;
      const sourceUrl = pageUrl(data.pageURL);
      if (!sourceUrl) return [];
      const license = { status: 'licensed' as const, source: 'pixabay', sourceUrl, author: data.user,
        authorUrl: data.user_id ? `https://pixabay.com/users/${encodeURIComponent(data.user)}-${data.user_id}/` : undefined,
        licenseName: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/' };
      const base = { id: String(data.id), name: data.tags || input.query, type: input.type, license,
        tags: expandKeywords(`${input.query} ${data.tags}`).slice(0, 50), automatic: false };
      if (input.type === 'image') {
        const download = mediaUrl(data.fullHDURL) ?? mediaUrl(data.largeImageURL) ?? mediaUrl(data.webformatURL);
        const thumbnail = mediaUrl(data.webformatURL) ?? mediaUrl(data.previewURL);
        return download && thumbnail ? itemFrom({ ...base, download, thumbnail, preview: thumbnail,
          extension: '.jpg', width: data.imageWidth ?? 0, height: data.imageHeight ?? 0 }) : [];
      }
      const variants = ['medium', 'small', 'tiny', 'large'].flatMap(size => {
        const stream = data.videos?.[size];
        const url = mediaUrl(stream?.url), thumbnail = mediaUrl(stream?.thumbnail);
        return stream && url ? [{ ...stream, url, thumbnail }] : [];
      });
      const video = variants[0], thumbnail = variants.find(variant => variant.thumbnail)?.thumbnail;
      const preview = variants.reduce<typeof video | undefined>((smallest, variant) =>
        !smallest || variant.width < smallest.width ? variant : smallest, undefined);
      return video && thumbnail ? itemFrom({ ...base, thumbnail, preview: preview!.url,
        download: video.url, extension: '.mp4', width: video.width, height: video.height, durationMs: durationMs(data.duration) }) : [];
    });
    return { items, hasMore: input.page * PAGE_SIZE < page.totalHits };
  }
};
