import { z } from 'zod';

export const PublishingPlatformSchema = z.enum(['general', 'douyin', 'xiaohongshu', 'shorts', 'bilibili']);
export type PublishingPlatform = z.infer<typeof PublishingPlatformSchema>;
export const publishingPlatforms = {
  general: { label: '通用', aspect: 'source', cover: undefined, hint: '用一两句交代这条视频的内容。' },
  douyin: { label: '抖音', aspect: '9:16', cover: [1080, 1920], hint: '开头写观众会得到什么，随后补充具体信息。' },
  xiaohongshu: { label: '小红书', aspect: '9:16', cover: [1080, 1440], hint: '按笔记写法补充步骤、经验或适用场景。' },
  shorts: { label: 'YouTube Shorts', aspect: '9:16', cover: [1080, 1920], hint: '用简短标题说明视频的主题。' },
  bilibili: { label: 'B 站', aspect: '16:9', cover: [1600, 1000], hint: '在简介里写清主题、背景或涉及的版本。' }
} as const;

export const PublishDraftSchema = z.object({
  platform: PublishingPlatformSchema,
  frameMs: z.number().int().nonnegative().max(86_400_000),
  coverTitle: z.string().trim().max(54),
  title: z.string().trim().max(120),
  description: z.string().trim().max(2000),
  tags: z.string().trim().max(300)
}).strict();
export type PublishDraft = z.infer<typeof PublishDraftSchema>;
export const PublishCopyRequestSchema = z.object({ platform: PublishingPlatformSchema, evidence: z.string().trim().min(4).max(3600) }).strict();
export type PublishCopyRequest = z.infer<typeof PublishCopyRequestSchema>;
export interface PublishCopySuggestion { title: string; description: string; tags: string; quote: string }

export function publishCopy(draft: Pick<PublishDraft, 'title' | 'description' | 'tags'>): string {
  const tags = [...new Set(draft.tags.split(/[\s#＃,，、]+/u).filter(Boolean))].map(tag => `#${tag}`).join(' ');
  return [draft.title.trim(), draft.description.trim(), tags].filter(Boolean).join('\n\n');
}

export function usesSourceNumbers(text: string, source: string): boolean {
  const numbers = (value: string) => value.normalize('NFKC').match(/\d+(?:[.,]\d+)*(?:[%×倍万亿元])?/gu) ?? [];
  const allowed = new Set(numbers(source));
  return numbers(text).every(number => allowed.has(number));
}
