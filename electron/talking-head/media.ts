import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { FfprobeMediaProbe } from '../media/probe.js';
import { alignWithSenseVoiceProcess, type SenseVoiceProcessResult } from '../alignment/sensevoice-process.js';
import { verifySenseVoiceResources } from '../alignment/sensevoice.js';
import { mixNarration } from '../media/mix.js';
import { TalkTokenSchema, TalkRangeSchema, mergeTalkRanges, talkTimeline,
  type TalkToken, type TalkRange, type TalkProject } from '../../shared/talking-head.js';
import { parseTalkSilence } from './editing.js';

const run = promisify(execFile);
export interface TalkMediaTools { ffmpegPath: string; ffprobePath: string; senseVoiceRoot: string }
export async function talkMediaStatus(tools: TalkMediaTools | undefined): Promise<{ ready: boolean; message: string }> {
  if (!tools) return { ready: false, message: '口播精剪需要 FFmpeg 和 ffprobe，请准备应用媒体工具。' };
  try {
    await Promise.all([access(tools.ffmpegPath), access(tools.ffprobePath), verifySenseVoiceResources(tools.senseVoiceRoot)]);
    return { ready: true, message: '本地语音识别与媒体工具就绪' };
  } catch { return { ready: false, message: '口播语音模型或媒体工具尚未准备完成，请完成资源下载后重试。' }; }
}

/** Keep a private original and a normalized working copy; no destructive source edits. */
export async function importTalkVideo(file: string, directory: string, tools: TalkMediaTools, signal?: AbortSignal) {
  const metadata = await new FfprobeMediaProbe(tools.ffprobePath).probe(file);
  if (!metadata.width || !metadata.height || !metadata.durationMs || !metadata.hasAudio)
    throw new Error('请选择包含口播声音的视频文件');
  await mkdir(path.join(directory, 'media'), { recursive: true });
  const extension = path.extname(file).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/u.test(extension)) throw new Error('不支持的视频扩展名');
  const original = path.join(directory, `original${extension}`);
  signal?.throwIfAborted();
  await copyFile(file, original);
  signal?.throwIfAborted();
  const source = path.join(directory, 'media', 'source.mp4');
  await run(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', original,
    '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn',
    '-vf', "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
    '-af', 'aresample=48000:async=1:first_pts=0,apad', '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', source],
  { windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 });
  signal?.throwIfAborted();
  const normalized = await new FfprobeMediaProbe(tools.ffprobePath).probe(source);
  if (!normalized.width || !normalized.height || !normalized.durationMs || !normalized.hasAudio) throw new Error('原片标准化失败');
  return { name: path.basename(file), originalPath: file, width: normalized.width,
    height: normalized.height, durationMs: normalized.durationMs };
}

const AnalysisSchema = z.object({ version: z.literal(1), tokens: z.array(TalkTokenSchema),
  speech: z.array(TalkRangeSchema), silence: z.array(TalkRangeSchema) }).strict();
export type TalkAnalysis = z.infer<typeof AnalysisSchema>;
type Transcribe = (wav: string, signal?: AbortSignal) => Promise<SenseVoiceProcessResult>;

export function normalizeTalkTokens(result: SenseVoiceProcessResult, offsetMs: number, lengthMs: number,
  durationMs: number, first: boolean, last: boolean): TalkToken[] {
  // Two-second overlapping windows, each owns its center. Do not deduplicate repeated words by text.
  const ownStart = first ? 0 : offsetMs + 1000, ownEnd = last ? durationMs : offsetMs + 29000;
  return result.tokens.flatMap(token => {
    const text = token.text.replace(/▁/gu, ' ').replace(/^<[^>]*>$/u, '');
    const startMs = Math.max(0, Math.round(offsetMs + token.startMs));
    const endMs = Math.min(durationMs, offsetMs + lengthMs,
      Math.max(startMs + 1, Math.round(offsetMs + (token.endMs ?? token.startMs + 60))));
    const middle = (startMs + endMs) / 2;
    return text.trim() && middle >= ownStart && middle < ownEnd && endMs > startMs ? [{ text, startMs, endMs,
      confidence: token.confidence, timingSource: 'estimated' as const }] : [];
  });
}

export async function analyzeTalkVideo(directory: string, durationMs: number, tools: TalkMediaTools,
  signal: AbortSignal, progress: (fraction: number, message: string) => void,
  transcribe: Transcribe = (wav, signal) => alignWithSenseVoiceProcess(tools.senseVoiceRoot, wav, undefined, undefined, signal, true)
): Promise<TalkAnalysis> {
  const media = path.join(directory, 'media'), source = path.join(media, 'source.mp4');
  const tokens: TalkToken[] = [], speech: TalkRange[] = [];
  for (let offsetMs = 0; offsetMs < durationMs; offsetMs += 28000) {
    signal.throwIfAborted();
    progress(Math.min(.95, offsetMs / durationMs), `正在识别口播 ${Math.floor(offsetMs / 1000)} / ${Math.ceil(durationMs / 1000)} 秒…`);
    const lengthMs = Math.min(30000, durationMs - offsetMs), last = offsetMs + lengthMs >= durationMs;
    const chunk = path.join(media, `recognition-${offsetMs}.json`);
    let result: SenseVoiceProcessResult | undefined;
    try {
      result = z.object({ tokens: z.array(z.object({ text: z.string(), startMs: z.number().nonnegative(),
        endMs: z.number().positive().optional(), confidence: z.number().min(0).max(1).optional() })),
      speechSegments: z.array(TalkRangeSchema) }).parse(JSON.parse(await readFile(chunk, 'utf8')));
    } catch { /* Resume only complete, validated chunks. */ }
    if (!result) {
      const wav = path.join(media, 'recognition.wav');
      try {
        await run(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(offsetMs / 1000),
          '-i', source, '-t', String(lengthMs / 1000), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
        { windowsHide: true, signal, maxBuffer: 1024 * 1024 });
        result = await transcribe(wav, signal);
        if (!result.speechSegments) throw new Error('语音识别未返回语音边界，不能安全剪辑');
        signal.throwIfAborted();
        await writeFile(`${chunk}.tmp`, JSON.stringify({ tokens: result.tokens, speechSegments: result.speechSegments }));
        await rename(`${chunk}.tmp`, chunk);
      } finally { await rm(wav, { force: true }); }
    }
    tokens.push(...normalizeTalkTokens(result, offsetMs, lengthMs, durationMs, offsetMs === 0, last));
    speech.push(...(result.speechSegments ?? []).map(range => ({
      startMs: Math.max(0, offsetMs + Math.round(range.startMs)),
      endMs: Math.min(durationMs, offsetMs + lengthMs, offsetMs + Math.round(range.endMs))
    })).filter(range => range.endMs > range.startMs));
    if (last) break;
  }
  const ordered: TalkToken[] = [];
  for (const token of tokens.sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.max(token.startMs, ordered.at(-1)?.endMs ?? 0);
    if (token.endMs > startMs) ordered.push({ ...token, startMs });
  }
  progress(.96, '正在复核静音，保护语音和自然停顿…');
  const { stderr } = await run(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-i', source,
    '-vn', '-af', 'silencedetect=noise=-42dB:d=0.35', '-f', 'null', '-'],
  { windowsHide: true, signal, maxBuffer: 32 * 1024 * 1024 });
  const analysis = AnalysisSchema.parse({ version: 1, tokens: ordered,
    speech: mergeTalkRanges(speech), silence: parseTalkSilence(stderr, durationMs) });
  await writeFile(path.join(media, 'analysis.json'), JSON.stringify(analysis));
  return analysis;
}

/** Fades do not overlap segments or change their lengths, so picture and voice stay aligned. */
export function talkAudioFilter(project: TalkProject): string {
  const spans = talkTimeline(project);
  if (!spans.length) throw new Error('没有可导出的口播片段');
  const split = spans.length > 1 ? `[0:a]asplit=${spans.length}${spans.map((_, index) => `[a${index}]`).join('')};\n` : '';
  return split + spans.map((span, index) => {
    const duration = (span.endMs - span.startMs) / 1000;
    return `${spans.length > 1 ? `[a${index}]` : '[0:a]'}atrim=start=${span.startMs / 1000}:end=${span.endMs / 1000},asetpts=PTS-STARTPTS,apad,atrim=duration=${duration},afade=t=in:d=${Math.min(.003, duration / 4)},afade=t=out:st=${Math.max(0, duration - .003)}:d=${Math.min(.003, duration / 4)}[part${index}]`;
  }).join(';\n') + `;\n${spans.map((_, index) => `[part${index}]`).join('')}concat=n=${spans.length}:v=0:a=1[out]`;
}

export async function prepareTalkAudio(project: TalkProject, directory: string, tools: TalkMediaTools,
  resolveAsset: (id: string) => string, signal?: AbortSignal): Promise<string> {
  const spans = talkTimeline(project);
  const key = createHash('sha256').update(JSON.stringify(['talk-audio-v2', spans, project.audio])).digest('hex').slice(0, 24);
  const media = path.join(directory, 'media'), output = path.join(media, `mix-${key}.wav`);
  try { await access(output); return output; } catch { /* First render of this edit. */ }
  const filterFile = path.join(media, `cut-${key}.txt`), raw = path.join(media, `cut-${key}.wav`), temporary = path.join(media, `mix-${key}.tmp.wav`);
  const padded = path.join(media, `mix-${key}.padded.wav`);
  try {
    await writeFile(filterFile, talkAudioFilter(project));
    await run(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(media, 'source.mp4'),
      '-filter_complex_script', filterFile, '-map', '[out]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', raw],
    { windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 });
    await mixNarration(tools.ffmpegPath, raw, temporary, spans.at(-1)!.outputEndMs, {
      narrationVolume: project.audio.voiceVolume,
      bgm: project.audio.bgmAssetId ? { path: resolveAsset(project.audio.bgmAssetId), volume: project.audio.bgmVolume,
        ducking: project.audio.ducking } : undefined
    }, signal);
    // The shared loudness/limiter chain can flush a slightly shorter tail. Keep exact
    // output duration here, without changing the original mode's mixing behavior.
    await run(tools.ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', temporary,
      '-af', 'apad', '-t', String(spans.at(-1)!.outputEndMs / 1000), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', padded],
    { windowsHide: true, signal, maxBuffer: 1024 * 1024 });
    signal?.throwIfAborted();
    await rename(padded, output); return output;
  } finally { await Promise.all([raw, filterFile, temporary, padded].map(file => rm(file, { force: true }))); }
}
