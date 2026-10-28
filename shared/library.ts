import { z } from 'zod';

export const AssetTypeSchema = z.enum(['video', 'image', 'audio']);
export const AssetLicenseSchema = z.object({
  status: z.enum(['user-owned', 'licensed', 'unknown']),
  source: z.string().trim().min(1),
  note: z.string().trim().optional(),
  sourceUrl: z.string().url().optional(), author: z.string().optional(), licenseUrl: z.string().url().optional()
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
export const PexelsSearchSchema = z.object({
  query: z.string().trim().min(1).max(150), type: z.enum(['video', 'image']),
  page: z.number().int().min(1).max(100).default(1),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional()
}).strict();
export interface OnlineAsset {
  id: string; type: 'video' | 'image'; name: string; thumbnailUrl: string;
  sourceUrl: string; downloadUrl: string; author: string;
  width: number; height: number; durationMs?: number; tags: string[];
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
