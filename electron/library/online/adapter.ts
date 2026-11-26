import { z } from 'zod';
import { AssetLicenseSchema, OnlineTypeSchema, type CoverrTier, type OnlineSource, type OnlineType } from '../../../shared/library.js';

export const PAGE_SIZE = 12;
export const DAY = 24 * 60 * 60_000;
export const USER_AGENT = 'FrameSkiff/0.2.12 (https://github.com/hafung/LocalVideoFactory/issues)';

export const remoteMediaSchema = z.object({
  id: z.string(), type: OnlineTypeSchema, name: z.string(), thumbnail: z.string(), preview: z.string(),
  download: z.string(), extension: z.enum(['.jpg', '.png', '.webp', '.gif', '.avif', '.mp4', '.webm']),
  width: z.number().positive(), height: z.number().positive(), durationMs: z.number().positive().optional(),
  tags: z.array(z.string()), license: AssetLicenseSchema, automatic: z.boolean()
});
export type RemoteMedia = z.infer<typeof remoteMediaSchema>;
export const remotePageSchema = z.object({ items: z.array(remoteMediaSchema), hasMore: z.boolean() });
export type RemotePage = z.infer<typeof remotePageSchema>;

export type ProviderSearch = { query: string; type: OnlineType; page: number; orientation?: 'portrait' | 'landscape' | 'square' };
export type ProviderAccess = { key: string; tier: CoverrTier };
export type ApiRequest = (url: URL, init?: RequestInit) => Promise<Response>;

export interface OnlineAdapter {
  source: OnlineSource;
  types: OnlineType[];
  cacheMs: number;
  query(text: string): string;
  searchKey?(input: ProviderSearch): ProviderSearch;
  automatic(access: ProviderAccess): boolean;
  search(input: ProviderSearch, access: ProviderAccess, request: ApiRequest): Promise<RemotePage>;
  mediaUrl(value: string): string | undefined;
  trackDownload?(item: RemoteMedia, access: ProviderAccess, request: ApiRequest): Promise<void>;
}

export function httpsUrl(value: unknown, hosts: string[]): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname)) return url.href;
  } catch { /* Ignore malformed provider data. */ }
}

export function itemFrom(value: RemoteMedia): RemoteMedia[] {
  const parsed = remoteMediaSchema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}

export function matchesOrientation(item: RemoteMedia, orientation?: ProviderSearch['orientation']): boolean {
  if (!orientation) return true;
  const actual = item.width / item.height > 1.15 ? 'landscape' : item.height / item.width > 1.15 ? 'portrait' : 'square';
  return actual === orientation;
}

export function durationMs(seconds: unknown) {
  return typeof seconds === 'number' && seconds > 0 ? Math.round(seconds * 1000) || undefined : undefined;
}

export const searchText = (value: string) => value.trim().replace(/\s+/gu, ' ');
