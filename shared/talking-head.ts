import { z } from 'zod';

// Deliberately separate from EditPlan: recorded speech is the source of truth.
const ms = z.number().int().nonnegative();
export const TalkRangeSchema = z.object({ startMs: ms, endMs: ms }).strict()
  .refine(range => range.endMs > range.startMs, '时间区间无效');
export type TalkRange = z.infer<typeof TalkRangeSchema>;
export const TalkStrengthSchema = z.enum(['light', 'natural', 'tight']);
export const TalkCaptionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  reveal: z.enum(['sentence', 'character', 'phrase']).default('phrase'),
  highlight: z.enum(['none', 'color', 'box', 'scale']).default('color'),
  position: z.enum(['bottom', 'top']).default('bottom')
}).strict();
export const TalkTokenSchema = z.object({
  text: z.string().min(1).max(1000), startMs: ms, endMs: ms,
  confidence: z.number().min(0).max(1).optional(),
  timingSource: z.enum(['recognized', 'estimated'])
}).strict().refine(token => token.endMs > token.startMs, '语音时间无效');
export type TalkToken = z.infer<typeof TalkTokenSchema>;
export const TalkCueSchema = z.object({
  id: z.string().min(1).max(160), startMs: ms, endMs: ms,
  originalText: z.string().max(2000), text: z.string().max(2000),
  tokens: z.array(TalkTokenSchema).max(2000)
}).strict().refine(cue => cue.endMs > cue.startMs && cue.tokens.every(token =>
  token.startMs >= cue.startMs && token.endMs <= cue.endMs), '字幕时间无效');
export type TalkCue = z.infer<typeof TalkCueSchema>;
export const TalkCutSchema = z.object({
  id: z.string().min(1).max(160), startMs: ms, endMs: ms,
  kind: z.enum(['pause', 'filler', 'restart', 'manual']),
  reason: z.string().min(1).max(600), applied: z.boolean(),
  // A user choice survives strength changes; only untouched pauses are recalculated.
  decided: z.boolean().default(false)
}).strict().refine(cut => cut.endMs > cut.startMs, '剪辑时间无效');
export type TalkCut = z.infer<typeof TalkCutSchema>;
export const TalkOverlaySchema = z.object({
  id: z.string().min(1).max(160), cueId: z.string().min(1).max(160),
  type: z.enum(['callout', 'whiteboard', 'image', 'video']),
  text: z.string().trim().max(300).default(''),
  assetId: z.string().min(1).max(160).optional(),
  layout: z.enum(['cover', 'pip']).default('pip'),
  position: z.enum(['top-left', 'top-right']).default('top-right'),
  sourceInMs: ms.default(0), enabled: z.boolean().default(true)
}).strict().refine(overlay => ['image', 'video'].includes(overlay.type) ? !!overlay.assetId : !!overlay.text,
  '请填写图解文字或选择素材');
export type TalkOverlay = z.infer<typeof TalkOverlaySchema>;

export const TalkProjectSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal('talking-head'),
  id: z.string().uuid(), revision: z.number().int().positive(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  source: z.object({
    name: z.string().min(1), originalPath: z.string().min(1),
    durationMs: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive()
  }).strict(),
  strength: TalkStrengthSchema, captions: TalkCaptionSettingsSchema,
  // Raw cues/tokens always use source time, including after cuts and corrections.
  cues: z.array(TalkCueSchema).max(100000), cuts: z.array(TalkCutSchema).max(100000),
  speech: z.array(TalkRangeSchema).max(100000), silence: z.array(TalkRangeSchema).max(100000),
  overlays: z.array(TalkOverlaySchema).max(2000).default([]),
  audio: z.object({ voiceVolume: z.number().min(0).max(2).default(1),
    bgmAssetId: z.string().min(1).max(160).optional(), bgmVolume: z.number().min(0).max(1).default(.12),
    ducking: z.boolean().default(true) }).strict(),
  warnings: z.array(z.string().max(600)).max(30).default([])
}).strict().superRefine((project, context) => {
  for (const [key, ranges] of Object.entries({ cues: project.cues, cuts: project.cuts, speech: project.speech, silence: project.silence })) {
    if (ranges.some(range => range.endMs > project.source.durationMs))
      context.addIssue({ code: 'custom', message: `${key} 超出原片时长` });
  }
  for (const items of [project.cues, project.cuts, project.overlays]) {
    if (new Set(items.map(item => item.id)).size !== items.length)
      context.addIssue({ code: 'custom', message: '工程内 ID 重复' });
  }
  let previousEnd = 0;
  for (const cue of project.cues) {
    if (cue.startMs < previousEnd) context.addIssue({ code: 'custom', message: '字幕区间重叠或未排序' });
    previousEnd = cue.endMs;
  }
  if (project.overlays.some(overlay => !project.cues.some(cue => cue.id === overlay.cueId)))
    context.addIssue({ code: 'custom', message: '画面增强未关联有效字幕' });
  const removed = mergeTalkRanges(project.cuts.filter(cut => cut.applied));
  if (removed.reduce((sum, range) => sum + range.endMs - range.startMs, 0) >= project.source.durationMs)
    context.addIssue({ code: 'custom', message: '至少需要保留一段口播' });
});
export type TalkProject = z.infer<typeof TalkProjectSchema>;
export type TalkCaptionSettings = z.infer<typeof TalkCaptionSettingsSchema>;

export interface TalkSpan extends TalkRange { outputStartMs: number; outputEndMs: number }
export function mergeTalkRanges(ranges: TalkRange[]): TalkRange[] {
  const merged: TalkRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    const previous = merged.at(-1);
    if (previous && range.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, range.endMs);
    else merged.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return merged;
}
export function talkTimeline(project: Pick<TalkProject, 'source' | 'cuts'>): TalkSpan[] {
  const spans: TalkSpan[] = [];
  let source = 0, output = 0;
  for (const cut of [...mergeTalkRanges(project.cuts.filter(cut => cut.applied)),
    { startMs: project.source.durationMs, endMs: project.source.durationMs }]) {
    if (cut.startMs > source) {
      const endMs = Math.min(project.source.durationMs, cut.startMs);
      spans.push({ startMs: source, endMs, outputStartMs: output, outputEndMs: output + endMs - source });
      output += endMs - source;
    }
    source = Math.max(source, cut.endMs);
  }
  return spans;
}
export function talkDuration(project: Pick<TalkProject, 'source' | 'cuts'>): number {
  return talkTimeline(project).at(-1)?.outputEndMs ?? 0;
}
export function sourceToTalkTime(project: Pick<TalkProject, 'source' | 'cuts'>, sourceMs: number): number {
  const spans = talkTimeline(project);
  for (const span of spans) {
    if (sourceMs < span.startMs) return span.outputStartMs;
    if (sourceMs < span.endMs) return span.outputStartMs + sourceMs - span.startMs;
  }
  return spans.at(-1)?.outputEndMs ?? 0;
}

export const TalkCreateSchema = z.object({ sourcePath: z.string().min(1),
  strength: TalkStrengthSchema.default('natural') }).strict();
export const TalkUpdateSchema = z.object({
  revision: z.number().int().positive(), strength: TalkStrengthSchema.optional(),
  captions: TalkCaptionSettingsSchema.optional(), audio: TalkProjectSchema.shape.audio.optional(),
  edits: z.array(z.object({ cueId: z.string().min(1).max(160), text: z.string().max(2000) }).strict()).max(100000).optional(),
  cutDecisions: z.array(z.object({ cutId: z.string().min(1).max(160), applied: z.boolean() }).strict()).max(100000).optional(),
  manualCut: TalkRangeSchema.optional(), overlays: z.array(TalkOverlaySchema).max(2000).optional()
}).strict();
export type TalkUpdate = z.infer<typeof TalkUpdateSchema>;
export interface TalkPreview { entryUrl: string; sourceUrl: string; durationMs: number; width: number; height: number; warnings?: string[] }
export interface TalkResult { project: TalkProject; preview: TalkPreview }
export interface TalkProgress { jobId: string; phase: 'importing' | 'recognizing' | 'editing' | 'preparing' | 'complete' | 'cancelled' | 'error';
  progress: number; message: string; result?: TalkResult }
export interface TalkExportProgress { jobId: string; phase: 'preparing' | 'capturing' | 'encoding' | 'complete' | 'cancelled' | 'error';
  progress: number; message: string; outputPath?: string }
export interface TalkingHeadApi {
  status(): Promise<{ ready: boolean; message: string }>;
  create(input: z.input<typeof TalkCreateSchema>): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  resume(): Promise<TalkResult | null>;
  update(id: string, input: TalkUpdate): Promise<TalkResult>;
  export(id: string, kind: 'mp4' | 'srt' | 'ass'): Promise<{ jobId: string } | null>;
  cancelExport(jobId: string): Promise<void>;
  onProgress(listener: (event: TalkProgress) => void): () => void;
  onExportProgress(listener: (event: TalkExportProgress) => void): () => void;
}
