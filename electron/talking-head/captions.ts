import { alignTextTokens } from '../alignment/align-text.js';
import { segmentCaptionText } from '../composition/segmenter.js';
import { groupCaptionWords, type TimedCaptionWord } from '../../shared/caption-highlights.js';
import { talkTimeline, type TalkProject, type TalkCaptionSettings } from '../../shared/talking-head.js';

export interface TalkCaptionUnit { startChar: number; endChar: number; startMs: number; endMs: number }
export interface TalkOutputCue { id: string; text: string; startMs: number; endMs: number;
  characters: TalkCaptionUnit[]; phrases: TalkCaptionUnit[] }
export interface TalkCaptionState { startMs: number; endMs: number; visibleEnd: number; activeStart?: number; activeEnd?: number }
const nonLexical = /^[\p{P}\p{S}\s]+$/u;

/** Map corrected display text onto immutable acoustic evidence, then through the edit map. */
export function talkOutputCaptions(project: TalkProject): TalkOutputCue[] {
  const spans = talkTimeline(project);
  return project.cues.flatMap(cue => {
    const text = cue.text.replace(/\|/gu, ''), chars = Array.from(text);
    if (!text.trim()) return [];
    const characterSizes = chars.map(char => Array.from(char.normalize('NFKC').toLocaleLowerCase('zh-CN'))
      .filter(item => !nonLexical.test(item)).length);
    const spokenCharacters = characterSizes.reduce((total, size) => total + size, 0);
    const timed = spokenCharacters <= cue.endMs - cue.startMs
      ? alignTextTokens(text, cue.tokens, cue.startMs, cue.endMs) : [];
    const sourceChars: TalkCaptionUnit[] = [];
    let acousticCursor = 0;
    chars.forEach((char, index) => {
      const size = characterSizes[index];
      if (!size) return;
      const pieces = timed.slice(acousticCursor, acousticCursor + size); acousticCursor += size;
      if (pieces.length) sourceChars.push({ startChar: sourceChars.length ? index : 0, endChar: index + 1,
        startMs: pieces[0].startMs, endMs: pieces.at(-1)!.endMs });
    });
    for (let index = 0; index < sourceChars.length; index++) sourceChars[index].endChar = sourceChars[index + 1]?.startChar ?? chars.length;
    if (!sourceChars.length) sourceChars.push({ startChar: 0, endChar: chars.length, startMs: cue.startMs, endMs: cue.endMs });
    const manualBoundaries = new Set<number>();
    let charCursor = 0;
    for (const char of Array.from(cue.text)) { if (char === '|') manualBoundaries.add(charCursor); else charCursor++; }
    return spans.flatMap((span, spanIndex) => {
      const selected = sourceChars.filter(char => {
        const middle = (char.startMs + char.endMs) / 2;
        return middle >= span.startMs && middle < span.endMs;
      });
      if (!selected.length) return [];
      const from = selected[0].startChar, to = selected.at(-1)!.endChar;
      const cueText = chars.slice(from, to).join('');
      const shift = span.outputStartMs - span.startMs;
      const characters = selected.map(char => ({ ...char, startChar: char.startChar - from, endChar: char.endChar - from,
        startMs: Math.max(span.startMs, char.startMs) + shift, endMs: Math.min(span.endMs, char.endMs) + shift }));
      const startMs = Math.max(span.startMs, cue.startMs) + shift;
      const endMs = Math.min(span.endMs, cue.endMs) + shift;
      const words: TimedCaptionWord[] = segmentCaptionText(cueText).filter(part => part.lexical).flatMap(part => {
        const pieces = characters.filter(char => char.startChar < part.endChar && char.endChar > part.startChar);
        return pieces.length ? [{ ...part, startMs: pieces[0].startMs, endMs: pieces.at(-1)!.endMs,
          source: 'estimated' as const }] : [];
      });
      let phrases: TalkCaptionUnit[] = groupCaptionWords(cueText, words, 'phrase');
      if (manualBoundaries.size) {
        const boundaries = [0, ...[...manualBoundaries].map(boundary => boundary - from).filter(boundary => boundary > 0 && boundary < to - from), to - from];
        phrases = boundaries.slice(0, -1).flatMap((startChar, index) => {
          const endChar = boundaries[index + 1];
          const pieces = characters.filter(char => char.startChar < endChar && char.endChar > startChar);
          return pieces.length ? [{ startChar, endChar, startMs: pieces[0].startMs, endMs: pieces.at(-1)!.endMs }] : [];
        });
      }
      // Punctuation and spaces follow the group they belong to, and do not flash separately.
      phrases = phrases.map((phrase, index) => ({ ...phrase, startChar: index === 0 ? 0 : phrase.startChar,
        endChar: phrases[index + 1]?.startChar ?? Array.from(cueText).length }));
      return [{ id: `${cue.id}-${spanIndex}`, text: cueText, startMs, endMs, characters, phrases: phrases.length ? phrases : characters }];
    });
  });
}

/** Shared by HTML and ASS: cumulative reveal, with an independent active effect. */
export function talkCaptionStates(cue: TalkOutputCue, settings: TalkCaptionSettings): TalkCaptionState[] {
  const units = settings.reveal === 'character' ? cue.characters : cue.phrases;
  const boundaries = [...new Set([cue.startMs, cue.endMs, ...units.flatMap(unit => [unit.startMs, unit.endMs])])]
    .filter(time => time >= cue.startMs && time <= cue.endMs).sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((startMs, index) => {
    const active = units.find(unit => unit.startMs <= startMs && unit.endMs > startMs);
    const revealed = units.filter(unit => unit.startMs <= startMs).at(-1);
    return { startMs, endMs: boundaries[index + 1],
      visibleEnd: settings.reveal === 'sentence' ? Array.from(cue.text).length : revealed?.endChar ?? 0,
      activeStart: settings.highlight === 'none' ? undefined : active?.startChar,
      activeEnd: settings.highlight === 'none' ? undefined : active?.endChar };
  });
}

function timestamp(milliseconds: number, ass = false): string {
  const units = Math.max(0, Math.round(milliseconds / (ass ? 10 : 1))), base = ass ? 100 : 1000;
  const seconds = Math.floor(units / base);
  return `${String(Math.floor(seconds / 3600)).padStart(ass ? 1 : 2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}${ass ? '.' : ','}${String(units % base).padStart(ass ? 2 : 3, '0')}`;
}
export function talkSrt(project: TalkProject): string {
  return talkOutputCaptions(project).map((cue, index) => {
    // An empty line terminates a cue in SRT.
    const text = cue.text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    return `${index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${text}\n`;
  }).join('\n');
}
const assEscape = (value: string) => value.replace(/\\/gu, '＼').replace(/\{/gu, '｛').replace(/\}/gu, '｝').replace(/\r?\n/gu, '\\N');
export function talkAss(project: TalkProject): string {
  const { width, height } = project.source, portrait = height > width;
  const size = Math.round(width * (portrait ? .055 : .036));
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,${project.captions.position === 'top' ? 8 : 2},${Math.round(width * .07)},${Math.round(width * .07)},${Math.round(height * .1)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  if (!project.captions.enabled) return header;
  return header + talkOutputCaptions(project).flatMap(cue => talkCaptionStates(cue, project.captions).flatMap(state => {
    if (Math.round(state.endMs / 10) <= Math.round(state.startMs / 10) || state.visibleEnd === 0) return [];
    const chars = Array.from(cue.text);
    const slice = (start: number, end?: number) => assEscape(chars.slice(start, end).join(''));
    const activeStart = Math.min(state.visibleEnd, state.activeStart ?? state.visibleEnd);
    const activeEnd = Math.min(state.visibleEnd, state.activeEnd ?? state.visibleEnd);
    const effect = project.captions.highlight === 'box' ? '\\bord4\\3c&H355443&\\c&H0069FFD9&'
      : project.captions.highlight === 'scale' ? '\\fscx108\\fscy108\\c&H0069FFD9&' : '\\c&H0069FFD9&';
    const active = activeStart < activeEnd ? `{${effect}}${slice(activeStart, activeEnd)}{\\r}` : '';
    const hidden = state.visibleEnd < chars.length ? `{\\alpha&HFF&}${slice(state.visibleEnd)}` : '';
    const value = slice(0, activeStart) + active + slice(activeEnd, state.visibleEnd) + hidden;
    return [`Dialogue: 0,${timestamp(state.startMs, true)},${timestamp(state.endMs, true)},Default,,0,0,0,,${value}`];
  })).join('\n') + '\n';
}
