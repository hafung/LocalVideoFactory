import { describe, expect, it } from 'vitest';
import { CaptionCueSchema } from './edit-plan.js';
import { captionStates, groupCaptionWords, type TimedCaptionWord } from './caption-highlights.js';

describe('caption highlight timeline', () => {
  const words: TimedCaptionWord[] = [
    { text: '三个', tag: 'm', startChar: 0, endChar: 2, startMs: 100, endMs: 400, source: 'aligned' },
    { text: '步骤', tag: 'n', startChar: 2, endChar: 4, startMs: 400, endMs: 800, source: 'aligned' },
    { text: '做好', tag: 'v', startChar: 5, endChar: 7, startMs: 1200, endMs: 1600, source: 'estimated' }
  ];
  it('joins quantity and noun but respects punctuation and acoustic gaps', () => {
    const units = groupCaptionWords('三个步骤，做好', words, 'phrase');
    expect(units.map(unit => unit.text)).toEqual(['三个步骤', '做好']);
    expect(units[0]).toMatchObject({ startMs: 100, endMs: 800, timingSource: 'acoustic-derived' });
    expect(units[1].timingSource).toBe('estimated');
    expect(groupCaptionWords('三个步骤，做好', words, 'word')).toHaveLength(3);
  });
  it('holds the caption without highlight during silence and uses half-open intervals', () => {
    const cue = CaptionCueSchema.parse({ id: 'gap', text: '三个步骤，做好', startMs: 0, endMs: 1800,
      tokens: [], highlightUnits: groupCaptionWords('三个步骤，做好', words, 'phrase') });
    expect(captionStates(cue)).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 100, endMs: 800, startChar: 0, endChar: 4 },
      { startMs: 800, endMs: 1200 },
      { startMs: 1200, endMs: 1600, startChar: 5, endChar: 7 },
      { startMs: 1600, endMs: 1800 }
    ]);
    expect(captionStates(cue, 'none')).toEqual([{ startMs: 0, endMs: 1800 }]);
  });
  it('rejects overlapping ranges and mismatched display text', () => {
    const units = groupCaptionWords('三个步骤，做好', words, 'word');
    expect(CaptionCueSchema.safeParse({ id: 'bad', text: '三个步骤，做好', startMs: 0, endMs: 1800,
      tokens: [], highlightUnits: [{ ...units[0], text: '错字' }] }).success).toBe(false);
    expect(CaptionCueSchema.safeParse({ id: 'bad', text: '三个步骤，做好', startMs: 0, endMs: 1800,
      tokens: [], highlightUnits: [units[0], { ...units[1], startMs: 300 }] }).success).toBe(false);
  });
  it('keeps the noun attached to its modifier even when it exceeds the soft duration target', () => {
    const text = '真正的转机';
    const words: TimedCaptionWord[] = [
      { text: '真正', tag: 'a', startChar: 0, endChar: 2, startMs: 0, endMs: 660, source: 'aligned' },
      { text: '的', tag: 'uj', startChar: 2, endChar: 3, startMs: 660, endMs: 960, source: 'aligned' },
      { text: '转机', tag: 'n', startChar: 3, endChar: 5, startMs: 960, endMs: 1806, source: 'aligned' }
    ];
    expect(groupCaptionWords(text, words, 'phrase').map(unit => unit.text)).toEqual([text]);
    const quantity = [
      { ...words[0], text: '三个', tag: 'm', endMs: 800 },
      { ...words[2], text: '步骤', startChar: 2, endChar: 4, startMs: 800, endMs: 1600 }
    ];
    expect(groupCaptionWords('三个步骤', quantity, 'phrase').map(unit => unit.text)).toEqual(['三个步骤']);
  });
});
