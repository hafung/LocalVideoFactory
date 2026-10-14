import type { CaptionCue, CaptionHighlight, HighlightUnit } from './edit-plan.js';

export interface TimedCaptionWord {
  text: string;
  tag: string;
  startChar: number;
  endChar: number;
  startMs: number;
  endMs: number;
  source: 'aligned' | 'estimated';
}

const particle = /^(的|了|着|过|呢|吧|啊)$/u;
const separator = /[，。！？；：、,.!?;:\n]/u;

/** Keep timing evidence separate from the choice of visual grouping. */
export function groupCaptionWords(text: string, words: TimedCaptionWord[], mode: CaptionHighlight): HighlightUnit[] {
  if (mode === 'none') return [];
  const chars = Array.from(text);
  const groups: TimedCaptionWord[][] = [];
  for (const word of words) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const size = group ? group.reduce((total, item) => total + item.endChar - item.startChar, 0) : 0;
    const between = previous ? chars.slice(previous.endChar, word.startChar).join('') : '';
    const nounToPredicate = previous && /^[nr]/u.test(previous.tag) && /^[vdp]/u.test(word.tag) && size >= 2;
    const conjunction = previous && previous.tag === 'c';
    const completesModifier = (previous?.text === '的' && /^[na]/u.test(word.tag)) ||
      (previous?.tag === 'm' && /^n/u.test(word.tag) && size <= 3);
    const shouldBreak = mode === 'word' || !previous || separator.test(between) ||
      word.startMs - previous.endMs >= 300 ||
      size + word.endChar - word.startChar > 8 ||
      (!particle.test(word.text) && !completesModifier && (size >= 4 || word.endMs - group![0].startMs > 1500 || nounToPredicate || conjunction));
    if (shouldBreak) groups.push([word]); else group!.push(word);
  }
  return groups.map(group => {
    const first = group[0], last = group.at(-1)!;
    return {
      text: chars.slice(first.startChar, last.endChar).join(''),
      startChar: first.startChar, endChar: last.endChar,
      startMs: first.startMs, endMs: last.endMs,
      timingSource: group.every(word => word.source === 'aligned') ? 'acoustic-derived' : 'estimated',
      groupingSource: 'rule'
    };
  });
}

export interface CaptionState {
  startMs: number;
  endMs: number;
  startChar?: number;
  endChar?: number;
}

/** One complete caption persists through acoustic gaps; only its active range changes. */
export function captionStates(cue: CaptionCue, mode: CaptionHighlight = 'word'): CaptionState[] {
  if (mode === 'none') return [{ startMs: cue.startMs, endMs: cue.endMs }];
  const units = cue.highlightUnits ?? (() => {
    let cursor = 0;
    return cue.tokens.map(token => {
      const startChar = cursor; cursor += Array.from(token.text).length;
      return { ...token, startChar, endChar: cursor };
    });
  })();
  const states: CaptionState[] = [];
  let cursor = cue.startMs;
  for (const unit of units) {
    const startMs = Math.max(cursor, unit.startMs);
    const endMs = Math.min(cue.endMs, unit.endMs);
    if (startMs > cursor) states.push({ startMs: cursor, endMs: startMs });
    if (endMs > startMs) states.push({ startMs, endMs, startChar: unit.startChar, endChar: unit.endChar });
    cursor = Math.max(cursor, endMs);
  }
  if (cursor < cue.endMs) states.push({ startMs: cursor, endMs: cue.endMs });
  return states;
}

export function captionStateText(cue: CaptionCue, state: CaptionState): [string, string, string] {
  const chars = Array.from(cue.text);
  if (state.startChar === undefined) return [cue.text, '', ''];
  return [chars.slice(0, state.startChar).join(''), chars.slice(state.startChar, state.endChar).join(''),
    chars.slice(state.endChar).join('')];
}
