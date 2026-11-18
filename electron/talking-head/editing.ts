import { randomUUID } from 'node:crypto';
import { TalkProjectSchema, TalkUpdateSchema, mergeTalkRanges,
  type TalkProject, type TalkToken, type TalkCue, type TalkRange, type TalkCut, type TalkUpdate } from '../../shared/talking-head.js';

export function parseTalkSilence(log: string, durationMs: number): TalkRange[] {
  const ranges: TalkRange[] = [];
  let start: number | undefined;
  for (const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/gu)) {
    const time = Math.min(durationMs, Math.max(0, Math.round(Number(match[2]) * 1000)));
    if (match[1] === 'start') start = time;
    else if (start !== undefined) { if (time > start) ranges.push({ startMs: start, endMs: time }); start = undefined; }
  }
  if (start !== undefined && durationMs > start) ranges.push({ startMs: start, endMs: durationMs });
  return mergeTalkRanges(ranges);
}

export function talkCues(tokens: TalkToken[]): TalkCue[] {
  const cues: TalkCue[] = [];
  let batch: TalkToken[] = [];
  const flush = () => {
    if (!batch.length) return;
    const text = batch.map(token => token.text).join('').trim();
    if (text) cues.push({ id: `cue-${String(cues.length + 1).padStart(5, '0')}`, startMs: batch[0].startMs,
      endMs: batch.at(-1)!.endMs, originalText: text, text, tokens: batch });
    batch = [];
  };
  for (const token of tokens) {
    const previous = batch.at(-1);
    if (previous && (token.startMs - previous.endMs > 550 || token.endMs - batch[0].startMs > 6500 ||
      Array.from(batch.map(item => item.text).join('') + token.text).length > 26)) flush();
    batch.push(token);
    if (/[。！？!?；;]$/u.test(token.text.trim())) flush();
  }
  flush(); return cues;
}

export function pauseCuts(project: Pick<TalkProject, 'source' | 'speech' | 'silence' | 'strength'>): TalkCut[] {
  // VAD alone cannot prove a pause is empty. Require independently measured silence.
  if (!project.speech.length || !project.silence.length) return [];
  const [threshold, keep] = { light: [1800, 700], natural: [1300, 500], tight: [1000, 380] }[project.strength];
  const protectedSpeech = mergeTalkRanges(project.speech.map(range => ({
    startMs: Math.max(0, range.startMs - 180), endMs: Math.min(project.source.durationMs, range.endMs + 220)
  })));
  const cuts: TalkCut[] = [];
  let cursor = 0;
  for (const next of [...protectedSpeech, { startMs: project.source.durationMs, endMs: project.source.durationMs }]) {
    for (const silence of project.silence) {
      const startMs = Math.max(cursor, silence.startMs), endMs = Math.min(next.startMs, silence.endMs);
      if (endMs - startMs < threshold) continue;
      const from = startMs + Math.ceil(keep / 2), to = endMs - Math.floor(keep / 2);
      cuts.push({ id: `pause-${startMs}-${endMs}`, startMs: from, endMs: to, kind: 'pause',
        reason: `语音边界和静音检测均显示此处无声；保留约 ${keep} 毫秒间隔`, applied: true, decided: false });
    }
    cursor = Math.max(cursor, next.endMs);
  }
  return cuts;
}

export function fillerSuggestions(tokens: TalkToken[], durationMs: number): TalkCut[] {
  return tokens.flatMap((token, index) => {
    // No semantic claim: even an isolated "嗯" can be a meaningful answer.
    if (!/^[嗯呃额啊]+[，。！？,.!?]*$/u.test(token.text.trim()) || token.endMs - token.startMs > 1600) return [];
    const startMs = Math.max(tokens[index - 1]?.endMs ?? 0, token.startMs - 25);
    const endMs = Math.min(tokens[index + 1]?.startMs ?? durationMs, token.endMs + 25);
    if (endMs <= startMs) return [];
    return [{ id: `filler-${index}-${token.startMs}`, startMs, endMs, kind: 'filler' as const,
      reason: `疑似口头语「${token.text.trim()}」；也可能有表达意义，时间边界需试听确认`, applied: false, decided: false }];
  });
}

export function updateTalkProject(input: TalkProject, update: TalkUpdate): TalkProject {
  const change = TalkUpdateSchema.parse(update);
  if (change.revision !== input.revision) throw new Error('工程已更新，请重新载入后再修改');
  let project: TalkProject = structuredClone(input);
  if (change.strength && change.strength !== project.strength) {
    project.strength = change.strength;
    const protectedCuts = project.cuts.filter(cut => cut.kind !== 'pause' || cut.decided);
    project.cuts = [...protectedCuts, ...pauseCuts(project).filter(cut => !protectedCuts.some(other =>
      other.startMs < cut.endMs && other.endMs > cut.startMs))];
  }
  if (change.captions) project.captions = change.captions;
  if (change.audio) project.audio = change.audio;
  const edited = new Set<string>();
  for (const edit of change.edits ?? []) {
    if (edited.has(edit.cueId)) throw new Error('同一字幕不能重复修改');
    edited.add(edit.cueId);
    const cue = project.cues.find(cue => cue.id === edit.cueId);
    if (!cue) throw new Error('字幕不存在');
    cue.text = edit.text.replace(/\r\n?/gu, '\n');
  }
  for (const decision of change.cutDecisions ?? []) {
    const cut = project.cuts.find(cut => cut.id === decision.cutId);
    if (!cut) throw new Error('剪辑记录不存在');
    cut.applied = decision.applied; cut.decided = true;
  }
  if (change.manualCut) {
    if (change.manualCut.endMs > project.source.durationMs) throw new Error('剪辑超出原片时长');
    project.cuts.push({ ...change.manualCut, id: randomUUID(), kind: 'manual',
      applied: true, decided: true, reason: '手动删除的音视频片段，可恢复' });
  }
  if (change.overlays) project.overlays = change.overlays;
  project.revision++; project.updatedAt = new Date().toISOString();
  return TalkProjectSchema.parse(project);
}
