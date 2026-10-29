import { describe, expect, it } from 'vitest';
import { CaptionCueSchema } from '../../shared/edit-plan.js';
import { alignedCaptionCues } from '../alignment/align-text.js';
import { estimateCaptionCues } from './captions.js';
import { segmentCaptionText } from './segmenter.js';
import { readFileSync } from 'node:fs';
import { buildPhraseCaptionCues } from './phrase-captions.js';

describe('phrase captions', () => {
  it.each([{ ending: 'LF', newline: '\n' }, { ending: 'CRLF', newline: '\r\n' }])('matches the fixtures shared with the native CLI ($ending)', ({ newline }) => {
    const fixtureText = readFileSync(new URL('../../shared/fixtures/caption-groups.tsv', import.meta.url), 'utf8')
      .replace(/\r?\n/gu, newline);
    const fixtures = fixtureText.trim().split(/\r?\n/u);
    for (const line of fixtures) {
      const [text, expected] = line.split('\t');
      const words = segmentCaptionText(text).filter(part => part.lexical).map(part => ({ ...part,
        startMs: part.startChar * 100, endMs: part.endChar * 100, source: 'aligned' as const }));
      const cues = buildPhraseCaptionCues('fixture', text, words, 'phrase');
      expect(cues.flatMap(cue => cue.highlightUnits!.map(unit => unit.text)), text).toEqual(expected.split('|'));
    }
  });
  it('protects amounts, units and English identifiers and retains every display character', () => {
    const text = '这款产品199元，支持7天无理由退货。用SenseVoice！';
    const parts = segmentCaptionText(text);
    expect(parts.map(part => part.text).join('')).toBe(text);
    expect(parts.map(part => part.text)).toEqual(expect.arrayContaining(['199元', '7天', '无理由退货', 'SenseVoice']));
  });
  it('isolates custom dictionaries between calls', () => {
    expect(segmentCaptionText('声织自动成片', ['声织自动成片 100000 n']).map(part => part.text)).toEqual(['声织自动成片']);
    expect(segmentCaptionText('声织自动成片').map(part => part.text)).not.toEqual(['声织自动成片']);
  });
  it('produces meaningful multiword groups and keeps original punctuation in cues', () => {
    const text = '只要三个步骤，就能做出高级感。';
    const cues = estimateCaptionCues([{ id: 'demo', text, startMs: 0, endMs: 3200 }], 'phrase');
    expect(cues.map(cue => cue.text).join('')).toBe(text);
    expect(cues.flatMap(cue => cue.highlightUnits!.map(unit => unit.text))).toEqual(['只要', '三个步骤', '就能做出', '高级感']);
    for (const cue of cues) expect(CaptionCueSchema.safeParse(cue).success).toBe(true);
    expect(cues.flatMap(cue => cue.highlightUnits!).every(unit => unit.timingSource === 'estimated')).toBe(true);
  });
  it('maps repeated words and supplementary characters without losing offsets or crossing silence', () => {
    const cues = alignedCaptionCues('repeat', '😀你好，你好。', [
      { text: '你好', startMs: 100, endMs: 400 }, { text: '你好', startMs: 1000, endMs: 1300 }
    ], 0, 1400, 'phrase');
    expect(cues.map(cue => cue.text).join('')).toBe('😀你好，你好。');
    expect(cues.map(cue => [cue.startMs, cue.endMs])).toEqual([[100, 400], [1000, 1300]]);
    expect(cues[0].highlightUnits![0]).toMatchObject({ startChar: 1, endChar: 3, text: '你好' });
    expect(cues[0].highlightUnits![0].timingSource).toBe('estimated');
    for (const cue of cues) expect(CaptionCueSchema.safeParse(cue).success).toBe(true);
  });
});
