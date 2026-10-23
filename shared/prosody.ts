import { parseMarkedText } from './markup.js';

export const DEFAULT_NARRATION_SEED = 42;
export const PROSODY_VERSION = 'context-narration-v4';

export interface SpeechChunk {
  text: string;
  sentences: string[];
  pauseBeforeMs: number;
  pauseAfterMs: number;
}

const sentenceSegmenter = new Intl.Segmenter('zh', { granularity: 'sentence' });
const maxCharacters = 160;

function splitLongSentence(sentence: string): string[] {
  const parts: string[] = [];
  let remaining = sentence;
  while (Array.from(remaining).length > maxCharacters) {
    const characters = Array.from(remaining);
    const window = characters.slice(0, maxCharacters).join('');
    // Prefer a clause or word boundary. A long unpunctuated CJK sentence still
    // needs a bounded request; no characters are removed at that boundary.
    const boundaries = [...window.matchAll(/[，,：:；;、\s]+/gu)];
    const boundary = boundaries.reverse().find(match => (match.index ?? 0) >= window.length / 2);
    const end = boundary ? boundary.index! + boundary[0].length : window.length;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining.trim()) parts.push(remaining);
  return parts;
}

/** Plain text is the product input. Legacy pause markup remains an internal/CLI compatibility path. */
export function planSpeech(text: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let leadingPause = 0;
  for (const segment of parseMarkedText(text)) {
    if (segment.kind === 'pause') {
      const previous = chunks.at(-1);
      if (previous) previous.pauseAfterMs = segment.milliseconds;
      else leadingPause += segment.milliseconds;
      continue;
    }
    // A single line break often just wraps a script. Keep its sentences in the
    // same generation so the model retains the narrator's voice and delivery.
    // Blank lines and explicit pause markup still create paragraph boundaries.
    const paragraphs = segment.text.split(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/u).filter(paragraph => paragraph.trim());
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const sentences = [...sentenceSegmenter.segment(paragraph)]
        .flatMap(item => splitLongSentence(item.segment)).filter(sentence => sentence.trim());
      let packed: string[] = [];
      const flush = (pauseAfterMs: number) => {
        if (!packed.length) return;
        chunks.push({ text: packed.join('').trim(), sentences: packed.map(sentence => sentence.trim()),
          pauseBeforeMs: chunks.length === 0 ? leadingPause : 0, pauseAfterMs });
        packed = [];
      };
      for (const sentence of sentences) {
        if (packed.length && Array.from(packed.join('') + sentence).length > maxCharacters) flush(220);
        packed.push(sentence);
      }
      flush(paragraphIndex < paragraphs.length - 1 ? 420 : 0);
    }
  }
  return chunks;
}

export function spokenCharacterCount(text: string): number {
  return Array.from(text.normalize('NFKC')).filter(character => !/[\p{P}\p{S}\s]/u.test(character)).length;
}
