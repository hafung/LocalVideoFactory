import { z } from 'zod';

const relativePath = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
  .refine(value => !value.split('/').some(part => part === '.' || part === '..'));
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
export const MODEL_DOWNLOAD_MIRRORS = ['official', 'hf-mirror', 'modelscope'] as const;
export type ModelDownloadMirror = typeof MODEL_DOWNLOAD_MIRRORS[number];
const mirrorsSchema = z.object({
  'hf-mirror': httpsUrl.optional(),
  modelscope: httpsUrl.optional()
}).optional();
const file = z.object({
  path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().optional()
});
export const ModelDownloadsSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(file.extend({ url: httpsUrl, mirrors: mirrorsSchema })).min(1),
  archives: z.array(z.object({
    path: relativePath, url: httpsUrl, mirrors: mirrorsSchema,
    files: z.array(file.extend({ member: relativePath })).min(1)
  })),
  manifests: z.array(z.object({ path: relativePath, data: z.record(z.string(), z.unknown()) }))
});
export type ModelDownloads = z.infer<typeof ModelDownloadsSchema>;
export const OPTIONAL_MODELS = ['scene', 'search', 'clone'] as const;
export type OptionalModel = typeof OPTIONAL_MODELS[number];

export function modelGroup(file: string): 'basic' | OptionalModel {
  if (file.startsWith('scene-planner/')) return 'scene';
  if (file.startsWith('semantic/model/')) return 'search';
  if (file.startsWith('models/qwen3-tts-1.7b-base/')) return 'clone';
  return 'basic';
}

export interface ModelSetupStatus {
  state: 'bundled' | 'setup' | 'checking' | 'downloading' | 'ready' | 'error';
  message: string;
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
  activity?: 'importing' | 'verifying' | 'extracting';
}
export type OptionalModelStatus = Record<OptionalModel, {
  downloadable: boolean;
  installed: boolean;
  progress?: ModelSetupStatus;
}>;
export interface ModelStorageInfo {
  root: string;
  defaultRoot: string;
  mirror: ModelDownloadMirror;
  usedBytes: number;
  freeBytes?: number;
  canChange: boolean;
}
export interface ModelStorageMigrationResult {
  changed: boolean;
  migratedFiles: number;
  migratedBytes: number;
  warning?: string;
  storage: ModelStorageInfo;
}
