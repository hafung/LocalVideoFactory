import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Scene } from '../../shared/edit-plan.js';

const run = promisify(execFile);
export interface SourceRange { startMs: number; endMs: number }
export interface SourceAnalysis { ranges: SourceRange[]; warning?: string }
const cache = new Map<string, SourceAnalysis>();

/** Detect edits and nearly full black intervals; static product shots remain usable. */
export function parseSourceAnalysis(log: string, durationMs: number): SourceRange[] {
  const cuts = [...log.matchAll(/pts_time:([\d.]+)/gu)].map(match => Math.round(Number(match[1]) * 1000));
  const black = [...log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/gu)]
    .map(match => {
      const endMs = Math.round(Number(match[2]) * 1000);
      return { startMs: Math.round(Number(match[1]) * 1000), endMs: endMs >= durationMs - 300 ? durationMs : endMs };
    });
  const boundaries = [...new Set([0, durationMs, ...cuts, ...black.flatMap(range => [range.startMs, range.endMs])])]
    .filter(time => Number.isFinite(time) && time >= 0 && time <= durationMs).sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((startMs, index) => ({ startMs, endMs: boundaries[index + 1] }))
    .filter(range => range.endMs - range.startMs >= 100 && !black.some(dark => range.startMs < dark.endMs && range.endMs > dark.startMs));
}

export async function analyzeSource(file: string, durationMs: number, ffmpeg?: string, signal?: AbortSignal): Promise<SourceAnalysis> {
  if (!ffmpeg) return { ranges: [{ startMs: 0, endMs: durationMs }], warning: '缺少镜头检测工具，原视频按时间分布选段。' };
  signal?.throwIfAborted();
  const info = await stat(file);
  const key = `${file}:${info.size}:${info.mtimeMs}`;
  const cached = cache.get(key);
  if (cached) return cached;
  let result: SourceAnalysis;
  try {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-threads', '2', '-i', file,
      '-vf', "fps=4,scale=160:-2,blackdetect=d=0.15:pix_th=0.10:pic_th=0.98,select='gt(scene,0.35)',showinfo",
      '-an', '-sn', '-dn', '-f', 'null', '-'], { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal });
    const ranges = parseSourceAnalysis(stderr, durationMs);
    result = { ranges, ...(!ranges.length ? { warning: '原视频检测为黑场，已改用补充素材。' } : {}) };
  } catch (error) {
    signal?.throwIfAborted();
    result = { ranges: [{ startMs: 0, endMs: durationMs }], warning: '原视频镜头检测未完成，已按时间分布选段。' };
  }
  if (cache.size > 50) cache.clear();
  cache.set(key, result);
  return result;
}

/** Keep chronological order and distribute omitted time across the whole source. */
export function arrangeSourceScenes(slots: Scene[], durationMs: number, sourceRanges?: SourceRange[]): Scene[] {
  const ranges: Array<SourceRange & { offset: number }> = [];
  let total = 0; let lastEnd = 0;
  for (const range of [...(sourceRanges ?? [{ startMs: 0, endMs: durationMs }])].sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.max(0, lastEnd, Math.round(range.startMs));
    const endMs = Math.min(durationMs, Math.round(range.endMs));
    if (endMs <= startMs) continue;
    ranges.push({ startMs, endMs, offset: total }); total += endMs - startMs; lastEnd = endMs;
  }
  const demand = slots.reduce((sum, slot) => sum + slot.endMs - slot.startMs, 0);
  const slack = Math.max(0, total - demand);
  const scenes: Scene[] = [];
  let cursor = 0; let consumed = 0;
  for (const [index, slot] of slots.entries()) {
    const duration = slot.endMs - slot.startMs;
    if (slack > 0) {
      const maxStart = total - (demand - consumed);
      const desired = Math.round(Math.max(cursor, Math.min(maxStart, consumed + slack * (slots.length === 1 ? .5 : index / (slots.length - 1)))));
      const starts = ranges.flatMap(range => {
        const end = range.offset + range.endMs - range.startMs;
        if (end - range.offset < duration) return [];
        return [Math.max(range.offset, Math.min(desired, end - duration))];
      }).filter(start => start >= cursor && start <= maxStart);
      cursor = starts.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0] ?? Math.floor(desired);
    }
    const pieces: Scene[] = [];
    let output = slot.startMs;
    while (output < slot.endMs && cursor < total) {
      const range = ranges.find(item => cursor >= item.offset && cursor < item.offset + item.endMs - item.startMs);
      if (!range) break;
      const sourceInMs = range.startMs + cursor - range.offset;
      const length = Math.min(slot.endMs - output, range.endMs - sourceInMs);
      pieces.push({ ...slot, startMs: output, endMs: output + length, visual: { ...slot.visual,
        type: 'source', assetId: 'source-video', sourceInMs, sourceOutMs: sourceInMs + length, motion: 'none',
        intent: { ...slot.visual.intent, minDurationMs: length } } });
      cursor += length; output += length;
    }
    for (const [pieceIndex, piece] of pieces.entries()) {
      scenes.push({ ...piece, id: pieces.length === 1 && output === slot.endMs ? slot.id :
        pieces.length === 1 ? `${slot.id}-source` : `${slot.id}-source-${pieceIndex + 1}` });
    }
    if (output < slot.endMs) scenes.push({ ...slot, id: pieces.length ? `${slot.id}-fallback` : slot.id,
      startMs: output, visual: { ...slot.visual, type: 'kinetic-text', assetId: undefined,
        sourceInMs: undefined, sourceOutMs: undefined, motion: 'slow-zoom-in',
        intent: { ...slot.visual.intent, minDurationMs: slot.endMs - output } } });
    consumed += duration;
  }
  return scenes;
}

export function originalAudioSegments(scenes: Scene[]): Array<{ startMs: number; endMs: number; sourceInMs: number; sourceOutMs: number }> {
  const segments: ReturnType<typeof originalAudioSegments> = [];
  for (const scene of scenes.filter(item => item.visual.type === 'source')) {
    const sourceInMs = scene.visual.sourceInMs ?? 0;
    const sourceOutMs = scene.visual.sourceOutMs ?? sourceInMs + scene.endMs - scene.startMs;
    const previous = segments.at(-1);
    if (previous && previous.endMs === scene.startMs && previous.sourceOutMs === sourceInMs) {
      previous.endMs = scene.endMs; previous.sourceOutMs = sourceOutMs;
    } else segments.push({ startMs: scene.startMs, endMs: scene.endMs, sourceInMs, sourceOutMs });
  }
  return segments;
}
