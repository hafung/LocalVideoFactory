import type { AcousticToken, CaptionCue, CaptionHighlight } from '../../shared/edit-plan.js';
import { groupCaptionWords, type TimedCaptionWord } from '../../shared/caption-highlights.js';
import { segmentCaptionText } from './segmenter.js';

const ignored = /^[\p{P}\p{S}\s]+$/u;
const separators = /[，。！？；：、,.!?;:\n]/u;

export function timedCaptionWords(text: string, characters: AcousticToken[]): TimedCaptionWord[] {
  let cursor = 0;
  return segmentCaptionText(text).filter(part => part.lexical).map(part => {
    const count = Array.from(part.text.normalize('NFKC').toLocaleLowerCase('zh-CN')).filter(char => !ignored.test(char)).length;
    const pieces = characters.slice(cursor, cursor + count); cursor += count;
    if (pieces.length !== count || !count) throw new Error('字幕文字与字符时间映射不一致');
    return { ...part, startMs: pieces[0].startMs, endMs: pieces.at(-1)!.endMs,
      source: pieces.every(piece => piece.source === 'aligned' && piece.timingSource !== 'estimated') ? 'aligned' as const : 'estimated' as const };
  });
}

export function buildPhraseCaptionCues(id: string, text: string, words: TimedCaptionWord[], mode: CaptionHighlight): CaptionCue[] {
  if (!words.length) return [];
  const chars = Array.from(text);
  // Pack complete phrase groups into cues; a line boundary must not cut a phrase in half.
  const phrases = groupCaptionWords(text, words, 'phrase');
  const batches: typeof phrases[] = [];
  for (const phrase of phrases) {
    const batch = batches.at(-1), previous = batch?.at(-1);
    if (!previous || phrase.endChar - batch![0].startChar > 12 || phrase.startMs - previous.endMs >= 300 ||
        separators.test(chars.slice(previous.endChar, phrase.startChar).join(''))) batches.push([phrase]);
    else batch!.push(phrase);
  }
  return batches.map((batch, index) => {
    const first = batch[0], last = batch.at(-1)!;
    const from = index === 0 ? 0 : first.startChar;
    const to = batches[index + 1]?.[0].startChar ?? chars.length;
    const cueText = chars.slice(from, to).join('');
    const localWords = words.filter(word => word.startChar >= first.startChar && word.endChar <= last.endChar)
      .map(word => ({ ...word, startChar: word.startChar - from, endChar: word.endChar - from }));
    return { id: `${id}-phrase-${String(index + 1).padStart(2, '0')}`, text: cueText,
      startMs: first.startMs, endMs: last.endMs,
      tokens: localWords.map(word => ({ text: word.text, startMs: word.startMs, endMs: word.endMs, source: word.source,
        startChar: word.startChar, endChar: word.endChar, tag: word.tag })),
      highlightUnits: groupCaptionWords(cueText, localWords, mode), emphasis: [] };
  });
}
