import { z } from 'zod';
import { estimateDuration } from './markup.js';
import { planSpeech } from './prosody.js';

export const EDIT_PLAN_SCHEMA_VERSION = 1 as const;

const milliseconds = z.number().int().nonnegative();
const nonEmptyPath = z.string().trim().min(1);

export const CaptionHighlightSchema = z.enum(['none', 'word', 'phrase']);
export type CaptionHighlight = z.infer<typeof CaptionHighlightSchema>;

export const HighlightUnitSchema = z.object({
  text: z.string().min(1),
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().positive(),
  startMs: milliseconds,
  endMs: milliseconds,
  timingSource: z.enum(['acoustic-derived', 'estimated']),
  groupingSource: z.enum(['rule', 'manual'])
}).strict().refine(unit => unit.endMs > unit.startMs && unit.endChar > unit.startChar, {
  message: '高亮范围和时间必须有效'
});
export type HighlightUnit = z.infer<typeof HighlightUnitSchema>;

export const CanvasSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().max(120),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/u).default('#0c0d10')
}).strict();

export const AcousticTokenSchema = z.object({
  text: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(['aligned', 'estimated']),
  startChar: z.number().int().nonnegative().optional(),
  endChar: z.number().int().positive().optional(),
  tag: z.string().optional(),
  timingSource: z.enum(['acoustic-derived', 'estimated']).optional()
}).strict().refine(token => token.endMs > token.startMs, {
  message: '字幕 token 的结束时间必须晚于开始时间', path: ['endMs']
});

export const CaptionCueSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
  tokens: z.array(AcousticTokenSchema),
  highlightUnits: z.array(HighlightUnitSchema).optional(),
  manualGrouping: z.string().max(10000).optional(),
  emphasis: z.array(z.string()).default([])
}).strict().superRefine((cue, context) => {
  if (cue.endMs <= cue.startMs) {
    context.addIssue({ code: 'custom', message: '字幕结束时间必须晚于开始时间', path: ['endMs'] });
  }
  for (const [index, token] of cue.tokens.entries()) {
    if (token.startMs < cue.startMs || token.endMs > cue.endMs) {
      context.addIssue({ code: 'custom', message: '字幕 token 必须位于所属字幕区间内', path: ['tokens', index] });
    }
    if ((token.startChar === undefined) !== (token.endChar === undefined) ||
        (token.startChar !== undefined && token.endChar !== undefined &&
          (token.endChar <= token.startChar || token.endChar > Array.from(cue.text).length ||
            Array.from(cue.text).slice(token.startChar, token.endChar).join('') !== token.text))) {
      context.addIssue({ code: 'custom', message: '字幕词范围必须对应原文', path: ['tokens', index] });
    }
  }
  let previousChar = 0;
  let previousEnd = cue.startMs;
  for (const [index, unit] of (cue.highlightUnits ?? []).entries()) {
    if (unit.startChar < previousChar || unit.endChar > Array.from(cue.text).length || unit.startMs < previousEnd || unit.endMs > cue.endMs ||
        Array.from(cue.text).slice(unit.startChar, unit.endChar).join('') !== unit.text) {
      context.addIssue({ code: 'custom', message: '高亮组必须有序且对应字幕原文和时间', path: ['highlightUnits', index] });
    }
    previousChar = unit.endChar; previousEnd = unit.endMs;
  }
});

export const VisualIntentSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).max(12),
  mood: z.array(z.string().trim().min(1)).max(6).default([]),
  preferredTypes: z.array(z.enum(['source', 'video', 'image', 'kinetic-text'])).min(1),
  avoidAssetIds: z.array(z.string()).default([]),
  minDurationMs: z.number().int().positive(),
  orientation: z.enum(['portrait', 'landscape', 'square'])
}).strict();

export const VisualSelectionSchema = z.object({
  type: z.enum(['source', 'video', 'image', 'kinetic-text']),
  assetId: z.string().min(1).optional(),
  sourceInMs: milliseconds.optional(),
  sourceOutMs: milliseconds.optional(),
  fit: z.enum(['cover', 'contain']).default('cover'),
  motion: z.enum(['none', 'slow-zoom-in', 'slow-zoom-out', 'pan-left', 'pan-right']).default('none'),
  intent: VisualIntentSchema
}).strict().superRefine((visual, context) => {
  if (visual.sourceInMs !== undefined && visual.sourceOutMs !== undefined && visual.sourceOutMs <= visual.sourceInMs) {
    context.addIssue({ code: 'custom', message: '素材出点必须晚于入点', path: ['sourceOutMs'] });
  }
});

export const SceneSchema = z.object({
  id: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
  script: z.string().min(1),
  visual: VisualSelectionSchema,
  transition: z.enum(['cut', 'crossfade', 'dip-to-black']).default('cut')
}).strict().refine(scene => scene.endMs > scene.startMs, {
  message: '分镜结束时间必须晚于开始时间', path: ['endMs']
});

export const NarrationSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  startMs: milliseconds,
  endMs: milliseconds,
  audioPath: nonEmptyPath.optional(),
  sceneIds: z.array(z.string().min(1)).min(1).optional(),
  speechStartMs: milliseconds.optional(),
  speechEndMs: milliseconds.optional()
}).strict().refine(segment => segment.endMs > segment.startMs, {
  message: '旁白分段结束时间必须晚于开始时间', path: ['endMs']
}).superRefine((segment, context) => {
  const start = segment.speechStartMs ?? segment.startMs;
  const end = segment.speechEndMs ?? segment.endMs;
  if (start < segment.startMs || end > segment.endMs || end <= start) {
    context.addIssue({ code: 'custom', message: '语音区间必须位于旁白分段内', path: ['speechEndMs'] });
  }
});

export const NarrationChunkSchema = z.object({
  id: z.string().min(1), text: z.string().min(1),
  sceneIds: z.array(z.string().min(1)).min(1),
  pauseBeforeMs: milliseconds.max(10_000), pauseAfterMs: milliseconds.max(10_000)
}).strict();

export const EditPlanSchema = z.object({
  schemaVersion: z.literal(EDIT_PLAN_SCHEMA_VERSION),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(['draft', 'resolved', 'rendering', 'complete', 'error']),
  input: z.object({
    script: z.string().trim().min(1).max(8000),
    sourceVideoPath: nonEmptyPath.optional(),
    visualBrief: z.string().trim().max(300).optional(),
    storyKeywords: z.array(z.string().trim().min(1)).max(12).default([])
  }).strict(),
  canvas: CanvasSchema,
  template: z.object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    captionStyle: z.enum(['commerce-bold', 'opinion-clean', 'brand-minimal', 'info-card']),
    captionHighlight: CaptionHighlightSchema.optional()
  }).strict(),
  narration: z.object({
    state: z.enum(['pending', 'ready']),
    voiceId: z.string().min(1),
    audioPath: nonEmptyPath.optional(),
    estimatedDurationMs: z.number().int().positive(),
    durationMs: z.number().int().positive().optional(),
    segments: z.array(NarrationSegmentSchema),
    chunks: z.array(NarrationChunkSchema).optional()
  }).strict(),
  scenes: z.array(SceneSchema).min(1),
  captions: z.array(CaptionCueSchema),
  bgm: z.object({
    enabled: z.boolean(),
    assetId: z.string().min(1).optional(),
    volume: z.number().min(0).max(2),
    ducking: z.boolean()
  }).strict(),
  audio: z.object({
    narrationVolume: z.number().min(0).max(2),
    originalEnabled: z.boolean(),
    originalVolume: z.number().min(0).max(2),
    originalDucking: z.boolean()
  }).strict().default({ narrationVolume: 1, originalEnabled: false, originalVolume: 0.35, originalDucking: true }),
  output: z.object({
    format: z.literal('mp4'),
    playbackRate: z.number().min(0.25).max(4).default(1),
    videoCodec: z.enum(['h264', 'hevc']).default('h264'),
    audioCodec: z.literal('aac'),
    outputPath: nonEmptyPath.optional()
  }).strict(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional()
}).strict().superRefine((plan, context) => {
  let previousEnd = 0;
  for (const [index, scene] of plan.scenes.entries()) {
    if (scene.startMs < previousEnd) {
      context.addIssue({ code: 'custom', message: '分镜时间不得重叠', path: ['scenes', index, 'startMs'] });
    }
    previousEnd = scene.endMs;
  }

  if (['resolved', 'rendering', 'complete'].includes(plan.status)) {
    if (plan.narration.state !== 'ready' || !plan.narration.audioPath || !plan.narration.durationMs) {
      context.addIssue({ code: 'custom', message: 'resolved 及后续状态必须包含已生成旁白和真实时长', path: ['narration'] });
    }
    if (plan.scenes.some(scene => scene.visual.type !== 'kinetic-text' && !scene.visual.assetId)) {
      context.addIssue({ code: 'custom', message: 'resolved 及后续状态的媒体分镜必须解析到素材', path: ['scenes'] });
    }
    if (plan.narration.durationMs) {
      if (plan.scenes[0]?.startMs !== 0) {
        context.addIssue({ code: 'custom', message: '已解析分镜必须从 0ms 开始', path: ['scenes', 0, 'startMs'] });
      }
      for (let index = 1; index < plan.scenes.length; index++) {
        if (plan.scenes[index].startMs !== plan.scenes[index - 1].endMs) {
          context.addIssue({ code: 'custom', message: '已解析分镜必须连续覆盖旁白', path: ['scenes', index, 'startMs'] });
        }
      }
      if (plan.scenes.at(-1)?.endMs !== plan.narration.durationMs) {
        context.addIssue({ code: 'custom', message: '已解析分镜必须覆盖完整旁白时长', path: ['scenes'] });
      }
      for (const [index, cue] of plan.captions.entries()) {
        if (cue.endMs > plan.narration.durationMs) {
          context.addIssue({ code: 'custom', message: '字幕不得超出旁白时长', path: ['captions', index, 'endMs'] });
        }
      }
    }
  }
});

export type EditPlan = z.infer<typeof EditPlanSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type AcousticToken = z.infer<typeof AcousticTokenSchema>;
export type VisualIntent = z.infer<typeof VisualIntentSchema>;

export const DraftPlanRequestSchema = z.object({
  script: z.string().trim().min(1).max(8000),
  voiceId: z.string().min(1),
  sourceVideoPath: nonEmptyPath.optional(),
  visualBrief: z.string().trim().max(300).optional(),
  aspectRatio: z.enum(['9:16', '16:9', '1:1']).optional(),
  templateId: z.string().min(1).optional(),
  captionStyle: z.enum(['commerce-bold', 'opinion-clean', 'brand-minimal', 'info-card']).optional(),
  captionHighlight: CaptionHighlightSchema.optional()
}).strict();

export type DraftPlanRequest = z.infer<typeof DraftPlanRequestSchema>;

export type CreateDraftEditPlanInput = DraftPlanRequest & {
  id: string;
  keywords?: (text: string) => string[];
  storyKeywords?: string[];
  now?: Date;
};

const CANVASES = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 }
} as const;

function orientationFor(aspectRatio: NonNullable<CreateDraftEditPlanInput['aspectRatio']>): VisualIntent['orientation'] {
  if (aspectRatio === '9:16') return 'portrait';
  if (aspectRatio === '16:9') return 'landscape';
  return 'square';
}

export function createDraftEditPlan(input: CreateDraftEditPlanInput): EditPlan {
  const script = input.script.trim();
  const speech = planSpeech(script);
  const chunks = speech.flatMap(chunk => chunk.sentences);
  if (chunks.length === 0) throw new Error('请输入有效文案');

  const aspectRatio = input.aspectRatio ?? '9:16';
  const estimatedDurationMs = Math.max(1000, chunks.length, Math.round(estimateDuration(speech.map(chunk => chunk.text).join(' ')) * 1000)
    + speech.reduce((sum, chunk) => sum + chunk.pauseBeforeMs + chunk.pauseAfterMs, 0));
  const weights = chunks.map(chunk => Math.max(1, Array.from(chunk).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const sourceType = input.sourceVideoPath ? 'source' as const : 'kinetic-text' as const;
  let cursor = 0;
  const scenes: Scene[] = chunks.map((chunk, index) => {
    const endMs = index === chunks.length - 1
      ? estimatedDurationMs
      : Math.max(cursor + 1, Math.round(estimatedDurationMs * weights.slice(0, index + 1).reduce((sum, weight) => sum + weight, 0) / totalWeight));
    const scene: Scene = {
      id: `scene-${String(index + 1).padStart(3, '0')}`,
      startMs: cursor,
      endMs,
      script: chunk,
      visual: {
        type: sourceType,
        assetId: input.sourceVideoPath ? 'source-video' : undefined,
        fit: 'cover',
        motion: input.sourceVideoPath ? 'none' : 'slow-zoom-in',
        intent: {
          keywords: input.keywords?.(chunk).slice(0, 12) ?? [],
          mood: [],
          preferredTypes: input.sourceVideoPath
            ? ['source', 'video', 'image', 'kinetic-text']
            : ['video', 'image', 'kinetic-text'],
          avoidAssetIds: [],
          minDurationMs: Math.max(1, endMs - cursor),
          orientation: orientationFor(aspectRatio)
        }
      },
      transition: index === 0 ? 'cut' : 'crossfade'
    };
    cursor = endMs;
    return scene;
  });

  const timestamp = (input.now ?? new Date()).toISOString();
  let sceneIndex = 0;
  const narrationChunks = speech.map((chunk, index) => ({
    id: `speech-${String(index + 1).padStart(3, '0')}`, text: chunk.text,
    sceneIds: chunk.sentences.map(() => scenes[sceneIndex++].id),
    pauseBeforeMs: chunk.pauseBeforeMs, pauseAfterMs: chunk.pauseAfterMs
  }));
  return EditPlanSchema.parse({
    schemaVersion: EDIT_PLAN_SCHEMA_VERSION,
    id: input.id,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'draft',
    input: { script, sourceVideoPath: input.sourceVideoPath, visualBrief: input.visualBrief,
      storyKeywords: input.storyKeywords?.slice(0, 12) ?? [] },
    canvas: { ...CANVASES[aspectRatio], fps: 30, background: '#0c0d10' },
    template: {
      id: input.templateId ?? 'voxweave-auto-v1',
      version: 1,
      captionStyle: input.captionStyle ?? 'commerce-bold',
      captionHighlight: input.captionHighlight
    },
    narration: {
      state: 'pending',
      voiceId: input.voiceId,
      estimatedDurationMs,
      segments: [],
      chunks: narrationChunks
    },
    scenes,
    captions: [],
    bgm: { enabled: false, volume: 0.13, ducking: true },
    audio: { narrationVolume: 1, originalEnabled: false, originalVolume: 0.35, originalDucking: true },
    output: { format: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }
  });
}
