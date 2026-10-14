import { z } from 'zod';

const relativePath = z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
  .refine(value => !value.split('/').some(part => part === '.' || part === '..'));
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
const file = z.object({
  path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().positive().optional()
});
export const ModelDownloadsSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(file.extend({ url: httpsUrl })).min(1),
  archives: z.array(z.object({
    path: relativePath, url: httpsUrl,
    files: z.array(file.extend({ member: relativePath })).min(1)
  })),
  manifests: z.array(z.object({ path: relativePath, data: z.record(z.string(), z.unknown()) }))
});
export type ModelDownloads = z.infer<typeof ModelDownloadsSchema>;
export interface ModelSetupStatus {
  state: 'bundled' | 'checking' | 'downloading' | 'ready' | 'error';
  message: string;
  completedFiles: number;
  totalFiles: number;
  downloadedBytes: number;
  totalBytes?: number;
}
