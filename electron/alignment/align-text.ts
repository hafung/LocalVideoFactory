import type { AcousticToken, CaptionCue, CaptionHighlight } from '../../shared/edit-plan.js';
import { segmentChinese } from '../composition/segmenter.js';
import { buildPhraseCaptionCues, timedCaptionWords } from '../composition/phrase-captions.js';

export interface RecognizedToken {
  text: string;
  startMs: number;
  endMs?: number;
  confidence?: number;
}

type CharacterToken = Omit<RecognizedToken, 'endMs'> & { character: string; endMs: number; estimated: boolean };

const ignored = /^[\p{P}\p{S}\s]+$/u;

function characters(value: string): string[] {
  return Array.from(value.normalize('NFKC').toLocaleLowerCase('zh-CN')).filter(character => !ignored.test(character));
}

function expandRecognized(tokens: RecognizedToken[], fallbackEndMs: number): CharacterToken[] {
  return tokens.flatMap((token, tokenIndex) => {
    const chars = characters(token.text);
    if (!chars.length) return [];
    const nextStart = tokens[tokenIndex + 1]?.startMs;
    const endMs = token.endMs ?? nextStart ?? fallbackEndMs;
    const duration = Math.max(chars.length, endMs - token.startMs);
    return chars.map((character, index) => ({
      ...token,
      character,
      estimated: chars.length > 1,
      startMs: token.startMs + Math.round(duration * index / chars.length),
      endMs: token.startMs + Math.round(duration * (index + 1) / chars.length)
    }));
  });
}

function alignment(reference: string[], recognized: CharacterToken[]): Array<number | undefined> {
  const rows = reference.length + 1;
  const columns = recognized.length + 1;
  const costs = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 0; row < rows; row++) costs[row][0] = row;
  for (let column = 0; column < columns; column++) costs[0][column] = column;
  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const substitution = costs[row - 1][column - 1] + (reference[row - 1] === recognized[column - 1].character ? 0 : 1);
      costs[row][column] = Math.min(costs[row - 1][column] + 1, costs[row][column - 1] + 1, substitution);
    }
  }
  const result: Array<number | undefined> = Array(reference.length).fill(undefined);
  let row = reference.length;
  let column = recognized.length;
  while (row > 0 || column > 0) {
    if (row > 0 && column > 0) {
      const penalty = reference[row - 1] === recognized[column - 1].character ? 0 : 1;
      if (costs[row][column] === costs[row - 1][column - 1] + penalty) {
        if (penalty === 0) result[row - 1] = column - 1;
        row--; column--; continue;
      }
    }
    if (row > 0 && costs[row][column] === costs[row - 1][column] + 1) row--;
    else column--;
  }
  return result;
}

export function alignTextTokens(
  originalText: string,
  recognizedTokens: RecognizedToken[],
  startMs: number,
  endMs: number
): AcousticToken[] {
  const reference = characters(originalText);
  if (!reference.length) return [];
  if (endMs - startMs < reference.length) throw new Error('声学区间过短，无法映射原文字符');
  const recognized = expandRecognized(recognizedTokens, endMs);
  const matches = alignment(reference, recognized);
  const anchors = matches.map((matched, index) => matched === undefined ? undefined : ({
    index, startMs: recognized[matched].startMs, endMs: recognized[matched].endMs,
    confidence: recognized[matched].confidence, estimated: recognized[matched].estimated
  }));
  const intervals = anchors.map(anchor => anchor && ({ startMs: anchor.startMs, endMs: anchor.endMs }));
  for (let index = 0; index < intervals.length;) {
    if (intervals[index]) { index++; continue; }
    let next = index + 1;
    while (next < intervals.length && !intervals[next]) next++;
    const from = intervals[index - 1]?.endMs ?? startMs;
    const to = intervals[next]?.startMs ?? endMs;
    for (let cursor = index; cursor < next; cursor++) intervals[cursor] = {
      startMs: Math.round(from + (to - from) * (cursor - index) / (next - index)),
      endMs: Math.round(from + (to - from) * (cursor - index + 1) / (next - index))
    };
    index = next;
  }
  let previousEnd = startMs;
  return reference.map((text, index) => {
    const interval = intervals[index]!;
    const latestEnd = endMs - (reference.length - index - 1);
    const start = Math.max(previousEnd, Math.min(latestEnd - 1, interval.startMs));
    const end = Math.max(start + 1, Math.min(latestEnd, interval.endMs));
    previousEnd = end;
    return { text, startMs: start, endMs: end,
      confidence: anchors[index]?.confidence, source: anchors[index] ? 'aligned' as const : 'estimated' as const,
      timingSource: anchors[index] && !anchors[index]!.estimated ? 'acoustic-derived' as const : 'estimated' as const };
  });
}

export function alignedCaptionCues(
  id: string,
  originalText: string,
  recognizedTokens: RecognizedToken[],
  startMs: number,
  endMs: number,
  highlight?: CaptionHighlight
): CaptionCue[] {
  const aligned = alignTextTokens(originalText, recognizedTokens, startMs, endMs);
  if (!aligned.length) return [];
  if (highlight) return buildPhraseCaptionCues(id, originalText, timedCaptionWords(originalText, aligned), highlight);
  const words = segmentChinese(originalText).filter(word => !ignored.test(word));
  const cues: CaptionCue[] = [];
  let characterCursor = 0;
  let cueTokens: AcousticToken[] = [];
  const flush = () => {
    if (!cueTokens.length) return;
    cues.push({
      id: `${id}-aligned-${String(cues.length + 1).padStart(2, '0')}`,
      text: cueTokens.map(token => token.text).join(''),
      startMs: cueTokens[0].startMs, endMs: cueTokens.at(-1)!.endMs,
      tokens: cueTokens, emphasis: []
    });
    cueTokens = [];
  };
  for (const word of words) {
    const size = characters(word).length;
    const pieces = aligned.slice(characterCursor, characterCursor + size);
    characterCursor += size;
    if (!pieces.length) continue;
    if (cueTokens.length && pieces[0].startMs - cueTokens.at(-1)!.endMs >= 180) flush();
    cueTokens.push({
      text: word,
      startMs: pieces[0].startMs,
      endMs: pieces.at(-1)!.endMs,
      confidence: pieces.every(piece => piece.confidence !== undefined)
        ? pieces.reduce((sum, piece) => sum + piece.confidence!, 0) / pieces.length
        : undefined,
      source: pieces.every(piece => piece.source === 'aligned') ? 'aligned' : 'estimated'
    });
    const count = cueTokens.reduce((sum, token) => sum + characters(token.text).length, 0);
    if (count >= 4) {
      flush();
    }
  }
  flush();
  return cues;
}
