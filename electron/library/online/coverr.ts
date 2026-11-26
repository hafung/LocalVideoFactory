import { z } from 'zod';
import { englishSearchQuery, expandKeywords } from '../../../shared/keywords.js';
import { durationMs, httpsUrl, itemFrom, PAGE_SIZE, searchText, type OnlineAdapter } from './adapter.js';

const creator = z.union([z.string(), z.object({
  name: z.string().optional(), display_name: z.string().optional(), username: z.string().optional(),
  url: z.string().optional(), profile_url: z.string().optional()
})]);
const video = z.object({
  id: z.string().regex(/^[\w-]{1,120}$/u), title: z.string(), slug: z.string().nullish(), url: z.string().nullish(),
  poster: z.string().nullish(), thumbnail: z.string().nullish(),
  duration: z.number(), max_width: z.number(), max_height: z.number(), tags: z.array(z.string()).default([]),
  is_premium: z.boolean().optional(), is_sponsored: z.boolean().optional(), is_ai_generated: z.boolean().optional(),
  author: creator.nullish(), creator: creator.nullish(), contributor: creator.nullish(), user: creator.nullish(),
  urls: z.object({ mp4: z.string().optional(), mp4_preview: z.string().optional() })
});
const mediaUrl = (value: unknown) => httpsUrl(value, ['storage.coverr.co', 'cdn.coverr.co', 'cdn.coverr.co.uk']);
const pageUrl = (value: unknown) => httpsUrl(value, ['coverr.co', 'www.coverr.co']);

export const coverrAdapter: OnlineAdapter = {
  source: 'coverr', types: ['video'], cacheMs: 5 * 60_000, mediaUrl,
  query: value => englishSearchQuery(searchText(value)),
  automatic: access => access.tier !== 'demo',
  async search(input, { key, tier }, request) {
    const url = new URL('https://api.coverr.co/videos');
    const filters = ['is_ai_generated:false'];
    if (tier !== 'demo') filters.push('is_premium:all');
    if (input.orientation === 'portrait' || input.orientation === 'landscape') filters.push(`is_vertical:${input.orientation === 'portrait'}`);
    url.search = new URLSearchParams({ query: input.query, page: String(input.page - 1), page_size: String(PAGE_SIZE), urls: 'true',
      filter: filters.join(',') }).toString();
    const page = z.object({ hits: z.array(z.unknown()), pages: z.number() }).parse(await (await request(url, { headers: { 'x-api-key': key } })).json());
    const items = page.hits.flatMap(value => {
      const row = video.safeParse(value);
      if (!row.success) return [];
      const data = row.data;
      if (data.is_sponsored || data.is_ai_generated) return [];
      // Use the streaming rendition for local bytes and register the actual selection with PATCH.
      const download = mediaUrl(data.urls.mp4);
      const thumbnail = mediaUrl(data.thumbnail) ?? mediaUrl(data.poster);
      const preview = mediaUrl(data.urls.mp4_preview) ?? mediaUrl(data.urls.mp4);
      if (!download || !thumbnail || !preview || (data.is_premium && !new URL(download).searchParams.get('token'))) return [];
      const author = data.creator ?? data.author ?? data.contributor ?? data.user;
      const name = typeof author === 'string' ? author : author?.name ?? author?.display_name ?? author?.username;
      const authorUrl = typeof author === 'object' && author ? pageUrl(author.profile_url ?? author.url) : undefined;
      const sourceUrl = pageUrl(data.url) ?? `https://coverr.co/videos/${encodeURIComponent(data.slug || data.id)}`;
      const license = { status: 'licensed' as const, source: 'coverr', sourceUrl, author: name || 'Coverr', authorUrl,
        licenseName: 'Coverr License', licenseUrl: 'https://coverr.co/license', attributionRequired: tier === 'demo',
        note: tier === 'demo' ? '此素材来自 Coverr Demo API，展示时须标注 Coverr 和列出的创作者并附上链接。' : undefined };
      return itemFrom({ id: data.id, type: 'video', name: data.title, thumbnail, preview, download, extension: '.mp4',
        width: data.max_width, height: data.max_height, durationMs: durationMs(data.duration),
        tags: expandKeywords(`${input.query} ${data.tags.join(' ')}`).slice(0, 50), license, automatic: tier !== 'demo' });
    });
    return { items, hasMore: input.page < page.pages };
  },
  async trackDownload(item, { key }, request) {
    await request(new URL(`https://api.coverr.co/videos/${encodeURIComponent(item.id)}/stats/downloads`),
      { method: 'PATCH', headers: { 'x-api-key': key } });
  }
};
