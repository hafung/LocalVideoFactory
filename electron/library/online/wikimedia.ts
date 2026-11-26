import { z } from 'zod';
import { englishSearchQuery, expandKeywords } from '../../../shared/keywords.js';
import { durationMs, httpsUrl, itemFrom, PAGE_SIZE, searchText, type OnlineAdapter, type RemoteMedia } from './adapter.js';
import { OnlineFailure } from './transport.js';

const commons = 'https://commons.wikimedia.org';
const mediaUrl = (value: unknown) => httpsUrl(value, ['upload.wikimedia.org', 'thumb.wikimedia.org']);
const licensePage = `${commons}/wiki/Commons:Licensing#Public_domain`;
const formats: Record<string, RemoteMedia['extension'] | undefined> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif',
  'video/webm': '.webm', 'video/mp4': '.mp4'
};
const info = z.object({
  url: z.string(), thumburl: z.string().nullish(), descriptionurl: z.string(), user: z.string().optional(),
  mime: z.string(), width: z.number(), height: z.number(), size: z.number().optional(), duration: z.number().optional(),
  derivatives: z.array(z.unknown()).optional(),
  extmetadata: z.record(z.string(), z.object({ value: z.union([z.string(), z.number()]).optional() })).default({})
});
const page = z.object({ title: z.string(), index: z.number().default(0),
  imageinfo: z.array(info).optional(), videoinfo: z.array(info).optional() });
const derivative = z.object({ src: z.string(), type: z.string(), width: z.number().positive(), height: z.number().positive() });

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function plainText(html: string) {
  return html.replace(/<\/?(?:br|p|div|li)\b[^>]*>/giu, ' ').replace(/<[^>]*>/gu, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (original, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity] ?? original;
      const point = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : original;
    }).replace(/\s+/gu, ' ').trim().slice(0, 800);
}

function attributionLink(html: string) {
  const raw = html.match(/href=["']([^"']+)["']/iu)?.[1];
  if (!raw) return;
  try { return httpsUrl(new URL(raw.replace(/&amp;/giu, '&'), commons).href, ['commons.wikimedia.org']); } catch { return; }
}

export const wikimediaAdapter: OnlineAdapter = {
  source: 'wikimedia', types: ['video', 'image'], cacheMs: 30 * 60_000, mediaUrl, automatic: () => true,
  query: value => englishSearchQuery(searchText(value)),
  searchKey: input => ({ ...input, orientation: undefined }),
  async search(input, _access, request) {
    const url = new URL(`${commons}/w/api.php`);
    const video = input.type === 'video';
    const type = video ? 'video' : 'bitmap';
    const query = input.query.replace(/["\u0000-\u001f]/gu, ' ').trim();
    url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5',
      generator: 'search', gsrnamespace: '6', gsrsearch: `"${query}" filetype:${type}`,
      gsrlimit: String(PAGE_SIZE), gsroffset: String((input.page - 1) * PAGE_SIZE),
      prop: video ? 'videoinfo' : 'imageinfo',
      [video ? 'viprop' : 'iiprop']: `url|size|mime|user|extmetadata${video ? '|derivatives' : ''}`,
      [video ? 'viurlwidth' : 'iiurlwidth']: '480',
      [video ? 'viextmetadatafilter' : 'iiextmetadatafilter']: 'Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|Copyrighted|AttributionRequired|Restrictions'
    }).toString();
    const response = await request(url);
    const data = z.object({ query: z.object({ pages: z.array(z.unknown()) }).optional(),
      continue: z.object({ gsroffset: z.number().optional() }).optional(),
      error: z.object({ code: z.string() }).optional() }).parse(await response.json());
    if (data.error) {
      if (['maxlag', 'ratelimited', 'readonly'].includes(data.error.code)) throw new OnlineFailure('cooldown', 60_000);
      throw new OnlineFailure('network');
    }
    const items = (data.query?.pages ?? []).flatMap(value => {
      const result = page.safeParse(value);
      return result.success ? [result.data] : [];
    }).sort((a, b) => a.index - b.index).flatMap(row => {
      const file = (video ? row.videoinfo : row.imageinfo)?.[0];
      if (!file) return [];
      const derivatives = (file.derivatives ?? []).flatMap(value => {
        const parsed = derivative.safeParse(value);
        if (!parsed.success) return [];
        const stream = parsed.data;
        const url = mediaUrl(stream.src);
        const mime = stream.type.split(';')[0];
        const extension = mime.startsWith('video/') ? formats[mime] : undefined;
        return url && extension ? [{ ...stream, url, extension }] : [];
      }).sort((a, b) => a.width * a.height - b.width * b.height);
      const rendition = derivatives.filter(stream => Math.max(stream.width, stream.height) <= 1920).at(-1) ?? derivatives[0];
      const original = (file.size ?? 0) <= 500 * 1024 * 1024 && file.mime.startsWith(video ? 'video/' : 'image/');
      const extension = rendition?.extension ?? (original ? formats[file.mime] : undefined);
      const download = rendition?.url ?? (original ? mediaUrl(file.url) : undefined);
      const thumbnail = mediaUrl(file.thumburl) ?? (input.type === 'image' ? download : undefined);
      const sourceUrl = httpsUrl(file.descriptionurl, ['commons.wikimedia.org']);
      if (!extension || !download || !thumbnail || !sourceUrl) return [];
      const meta = (key: string) => String(file.extmetadata[key]?.value ?? '');
      const short = plainText(meta('LicenseShortName') || meta('UsageTerms'));
      const cc = httpsUrl(meta('LicenseUrl').replace(/^http:/iu, 'https:'), ['creativecommons.org', 'www.creativecommons.org']);
      const ccPath = cc ? new URL(cc).pathname.replace(/\/(?:deed|legalcode)(?:\.[\w-]+)?\/?$/iu, '') : '';
      const zero = /^\/publicdomain\/zero\/1\.0\/?$/u.test(ccPath);
      const publicDomain = /^\/publicdomain\/mark\/1\.0\/?$/u.test(ccPath) ||
        (/^(?:public domain|pd)$/iu.test(short) && /^false$/iu.test(meta('Copyrighted')));
      const share = /^\/licenses\/by(?:-sa)?\/\d\.\d(?:\/[-a-z]+)?\/?$/iu.test(ccPath);
      if (!zero && !publicDomain && !share) return [];
      const attributionRequired = share || /^true$/iu.test(meta('AttributionRequired'));
      const artist = meta('Artist');
      const author = plainText(artist) || file.user || '作者未注明';
      const authorUrl = attributionLink(artist);
      const terms = plainText(meta('Restrictions')).replace(/^none$/iu, '');
      if (terms) return [];
      const credit = plainText(meta('Credit'));
      const license = { status: 'licensed' as const, source: 'wikimedia', sourceUrl, author, authorUrl,
        licenseName: short || (zero ? 'CC0 1.0' : publicDomain ? 'Public domain' : 'Creative Commons'),
        attributionRequired, licenseUrl: cc ?? licensePage,
        note: [credit, attributionRequired ? '发布时请保留作者、来源和许可链接，并注明剪辑等修改。' : '',
          ccPath.startsWith('/licenses/by-sa/') ? '改编素材须遵循相同许可。' : ''].filter(Boolean).join('\n') || undefined };
      const name = row.title.replace(/^File:/iu, '').replace(/\.[a-z\d]+$/iu, '') || input.query;
      return itemFrom({ id: row.title, type: input.type, name, thumbnail,
        preview: video ? derivatives[0]?.url ?? download : thumbnail,
        download, extension, width: rendition?.width ?? file.width, height: rendition?.height ?? file.height, durationMs: durationMs(file.duration),
        tags: expandKeywords(`${input.query} ${name}`).slice(0, 50), license, automatic: (zero || publicDomain) && !attributionRequired });
    });
    return { items, hasMore: data.continue?.gsroffset !== undefined };
  }
};
