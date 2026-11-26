import { z } from 'zod';

export const PEXELS_API_PAGE = 'https://www.pexels.com/api/';
export const PIXABAY_VIDEO_PAGE = 'https://pixabay.com/videos/';

export const AssetTypeSchema = z.enum(['video', 'image', 'audio']);
export const AssetLicenseSchema = z.object({
  status: z.enum(['user-owned', 'licensed', 'unknown']),
  source: z.string().trim().min(1),
  note: z.string().trim().optional(),
  sourceUrl: z.string().url().optional(), author: z.string().optional(), licenseUrl: z.string().url().optional(),
  licenseName: z.string().optional(), authorUrl: z.string().url().optional(), attributionRequired: z.boolean().optional()
}).strict();

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().trim().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  type: AssetTypeSchema,
  name: z.string().trim().min(1),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hasAudio: z.boolean(),
  thumbnailPath: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)),
  autoTags: z.array(z.string()).default([]),
  manualTags: z.array(z.string()).default([]),
  transcript: z.string().default(''),
  license: AssetLicenseSchema,
  additionalLicenses: z.array(AssetLicenseSchema).optional(),
  createdAt: z.string().datetime()
}).strict();

export const ImportAssetRequestSchema = z.object({
  filePath: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).max(50).default([]),
  license: AssetLicenseSchema.default({ status: 'user-owned', source: 'user-import' })
}).strict();

export const SearchAssetsRequestSchema = z.object({
  query: z.string().trim().max(500).default(''),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
  types: z.array(AssetTypeSchema).max(3).default(['video', 'image']),
  avoidAssetIds: z.array(z.string()).max(100).default([]),
  minDurationMs: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();

export type MediaAsset = z.infer<typeof MediaAssetSchema>;
export type ImportAssetRequest = z.infer<typeof ImportAssetRequestSchema>;
export type SearchAssetsRequest = z.infer<typeof SearchAssetsRequestSchema>;
export type AssetLicense = z.infer<typeof AssetLicenseSchema>;

export const UpdateTagsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  tags: z.array(z.string().trim().min(1).max(80)).max(50),
  mode: z.enum(['replace', 'append']).default('replace')
}).strict();
export const OnlineSourceSchema = z.enum(['pexels', 'pixabay', 'coverr', 'wikimedia']);
export type OnlineSource = z.infer<typeof OnlineSourceSchema>;
export const onlineSources = OnlineSourceSchema.options;
export const onlineSourceInfo = {
  pexels: { name: 'Pexels', home: 'https://www.pexels.com/', keyPage: PEXELS_API_PAGE },
  pixabay: { name: 'Pixabay', home: 'https://pixabay.com/', keyPage: 'https://pixabay.com/api/docs/' },
  coverr: { name: 'Coverr', home: 'https://coverr.co/', keyPage: 'https://coverr.co/developers' },
  wikimedia: { name: 'Wikimedia Commons', home: 'https://commons.wikimedia.org/', keyPage: undefined }
} satisfies Record<OnlineSource, { name: string; home: string; keyPage?: string }>;
export const CoverrTierSchema = z.enum(['demo', 'production', 'enterprise']);
export type CoverrTier = z.infer<typeof CoverrTierSchema>;
export const OnlineTypeSchema = z.enum(['video', 'image']);
export type OnlineType = z.infer<typeof OnlineTypeSchema>;
export const OnlineSearchSchema = z.object({
  query: z.string().trim().min(1).max(150),
  types: z.array(OnlineTypeSchema).min(1).max(2),
  page: z.number().int().min(1).max(100).default(1),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
  minDurationMs: z.number().int().nonnegative().optional()
}).strict();
export type OnlineSearchRequest = z.input<typeof OnlineSearchSchema>;
export interface OnlineSourceStatus {
  source: OnlineSource; types: OnlineType[]; automatic: boolean; configured: boolean; storedKey: boolean;
  state: 'ready' | 'missing' | 'unavailable' | 'invalid' | 'cooldown';
  retryAt?: number; tier?: CoverrTier;
}
export interface OnlineAsset {
  id: string; source: OnlineSource; type: OnlineType; name: string; thumbnailUrl: string; previewUrl: string;
  license: AssetLicense; width: number; height: number; durationMs?: number;
}
export interface OnlineSearchResult { source?: OnlineSource; items: OnlineAsset[]; query: string; page: number; hasMore: boolean; notice?: string }
export type OnlineDownloadResult = { asset: MediaAsset } | { alternatives: OnlineSearchResult };

export function isOnlineSource(source: string): source is OnlineSource {
  return OnlineSourceSchema.safeParse(source).success;
}
export interface ImportReport { assets: MediaAsset[]; errors: Array<{ name: string; message: string }> }

export const MusicSearchSchema = z.object({
  query: z.string().trim().min(1).max(150),
  page: z.number().int().min(1).max(100).default(1),
  license: z.enum(['cc0', 'cc0-by']).default('cc0')
}).strict();
export type MusicSearchRequest = z.input<typeof MusicSearchSchema>;
export interface OnlineMusic {
  id: string; name: string; author: string; provider: string;
  sourceUrl: string; previewUrl: string; durationMs: number;
  license: 'cc0' | 'by'; licenseVersion: string; licenseUrl: string;
  attribution: string; tags: string[];
}
export interface MusicSearchResult { items: OnlineMusic[]; query: string; page: number; pageCount: number }

export const ConfigureOnlineSourceSchema = z.object({
  source: OnlineSourceSchema.exclude(['wikimedia']), key: z.string().trim().max(300).optional(), tier: CoverrTierSchema.optional()
}).strict();
export type ConfigureOnlineSource = z.input<typeof ConfigureOnlineSourceSchema>;
