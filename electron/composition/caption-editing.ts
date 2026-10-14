import { EditPlanSchema, type CaptionCue, type CaptionHighlight, type EditPlan, type HighlightUnit } from '../../shared/edit-plan.js';
import { groupCaptionWords, type TimedCaptionWord } from '../../shared/caption-highlights.js';
import { segmentCaptionText } from './segmenter.js';

export function captionWords(cue: CaptionCue): TimedCaptionWord[] {
  const chars = Array.from(cue.text);
  const tags = segmentCaptionText(cue.text);
  let cursor = 0;
  return cue.tokens.map(token => {
    const size = Array.from(token.text).length;
    let start = token.startChar;
    if (start === undefined) {
      start = cursor;
      while (start + size <= chars.length && chars.slice(start, start + size).join('') !== token.text) start++;
    }
    const end = token.endChar ?? start + size;
    if (chars.slice(start, end).join('') !== token.text || end > chars.length) throw new Error('字幕词范围无法映射到原文');
    cursor = end;
    return { ...token, startChar: start, endChar: end,
      tag: token.tag ?? tags.find(part => part.startChar === start && part.endChar === end)?.tag ?? 'x' };
  });
}

export function manualCaptionUnits(cue: CaptionCue, annotated: string): HighlightUnit[] {
  if (cue.text.includes('|')) throw new Error('这条字幕包含分组符号 |，请使用自动分组');
  if (annotated.split('|').join('') !== cue.text) throw new Error('请只添加或移除 | 分组符号，保留字幕原文');
  const words = captionWords(cue);
  const units: HighlightUnit[] = [];
  let cursor = 0;
  for (const text of annotated.split('|')) {
    const startChar = cursor; cursor += Array.from(text).length;
    if (!text) throw new Error('分组符号两侧需要有字幕文字');
    const covered = words.filter(word => word.startChar < cursor && word.endChar > startChar);
    if (!covered.length) continue;
    const first = covered[0], last = covered.at(-1)!;
    const partialFirst = startChar > first.startChar, partialLast = cursor < last.endChar;
    const startMs = partialFirst ? Math.round(first.startMs + (first.endMs - first.startMs) * (startChar - first.startChar) / (first.endChar - first.startChar)) : first.startMs;
    const endMs = partialLast ? Math.round(last.startMs + (last.endMs - last.startMs) * (cursor - last.startChar) / (last.endChar - last.startChar)) : last.endMs;
    if (endMs <= startMs) throw new Error('分组过短，无法分配高亮时间');
    units.push({ text, startChar, endChar: cursor, startMs, endMs,
      timingSource: partialFirst || partialLast || covered.some(word => word.source === 'estimated') ? 'estimated' : 'acoustic-derived',
      groupingSource: 'manual' });
  }
  return units;
}

export function updateCaptionHighlight(plan: EditPlan, mode: CaptionHighlight,
  edits: Array<{ cueId: string; text: string }> = []): EditPlan {
  const byId = new Map(edits.map(edit => [edit.cueId, edit.text]));
  if (byId.size !== edits.length || edits.some(edit => !plan.captions.some(cue => cue.id === edit.cueId))) throw new Error('字幕编辑引用无效或重复的字幕');
  return EditPlanSchema.parse({ ...plan, status: 'resolved', revision: plan.revision + 1, updatedAt: new Date().toISOString(),
    template: { ...plan.template, captionHighlight: mode }, output: { ...plan.output, outputPath: undefined },
    captions: plan.captions.map(cue => {
      const annotated = byId.get(cue.id) ?? cue.manualGrouping;
      return { ...cue, manualGrouping: annotated,
        highlightUnits: mode === 'phrase' && annotated !== undefined ? manualCaptionUnits(cue, annotated)
          : groupCaptionWords(cue.text, captionWords(cue), mode) };
    }) });
}
