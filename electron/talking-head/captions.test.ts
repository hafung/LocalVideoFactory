import { describe, expect, it } from 'vitest';
import { talkFixture } from './fixtures.test-support.js';
import { talkAss, talkCaptionStates, talkOutputCaptions, talkSrt } from './captions.js';
import { updateTalkProject } from './editing.js';

describe('recorded-speech captions', () => {
  it('reveals characters cumulatively, attaching punctuation and retaining layout across gaps', () => {
    const project = talkFixture();
    project.captions.reveal = 'character';
    const cue = talkOutputCaptions(project)[0], states = talkCaptionStates(cue, project.captions);
    expect(states[0]).toMatchObject({ startMs: 100, visibleEnd: 1, activeStart: 0, activeEnd: 1 });
    expect(states.find(state => state.startMs === 700)).toMatchObject({ visibleEnd: 2, activeStart: undefined });
    expect(states.at(-1)).toMatchObject({ visibleEnd: 5 });
    expect(states.every((state, index) => index === 0 || state.visibleEnd >= states[index - 1].visibleEnd)).toBe(true);
  });
  it('supports manual phrase grouping independently of highlighting', () => {
    const project = updateTalkProject(talkFixture(), { revision: 1, edits: [{ cueId: 'first', text: '声织|很好。' }] });
    project.captions.highlight = 'none';
    const cue = talkOutputCaptions(project)[0];
    expect(cue.phrases.map(unit => Array.from(cue.text).slice(unit.startChar, unit.endChar).join(''))).toEqual(['声织', '很好。']);
    const states = talkCaptionStates(cue, project.captions);
    expect(states[0].visibleEnd).toBe(2);
    expect(states.every(state => state.activeStart === undefined)).toBe(true);
    project.captions.reveal = 'sentence';
    expect(talkCaptionStates(cue, project.captions).every(state => state.visibleEnd === 5)).toBe(true);
  });
  it('maps subtitles through edits and restores the original time without changing correction text', () => {
    const base = talkFixture({ cuts: [{ id: 'pause', startMs: 2000, endMs: 3500, kind: 'pause', applied: true, decided: true, reason: 'silence' }] });
    expect(talkOutputCaptions(base)[1].startMs).toBe(2500);
    const restored = updateTalkProject(base, { revision: 1, cutDecisions: [{ cutId: 'pause', applied: false }] });
    expect(talkOutputCaptions(restored)[1].startMs).toBe(4000);
  });
  it('removes deleted words from subtitles but leaves their stored original evidence recoverable', () => {
    const project = talkFixture({ cuts: [{ id: 'word', startMs: 80, endMs: 800, kind: 'manual', applied: true, decided: true, reason: 'manual' }] });
    expect(talkOutputCaptions(project)[0].text).toBe('很好。');
    expect(project.cues[0].text).toBe('声织很好。');
    expect(talkSrt(project)).not.toContain('声织');
  });
  it('still displays symbol-only corrections in phrase mode and preserves valid SRT blocks', () => {
    const project = updateTalkProject(talkFixture(), { revision: 1,
      edits: [{ cueId: 'first', text: '……' }, { cueId: 'second', text: '谢\n\n谢谢' }] });
    const cue = talkOutputCaptions(project)[0];
    expect(talkCaptionStates(cue, project.captions)[0].visibleEnd).toBe(2);
    expect(talkAss(project)).toContain('……');
    expect(talkSrt(project)).toContain('谢\n谢谢');
  });
  it('falls back to a whole cue if corrected text cannot be timed at millisecond precision', () => {
    const project = talkFixture();
    project.cues[0] = { ...project.cues[0], endMs: 101, tokens: [], text: '修改后的文字' };
    const cue = talkOutputCaptions(project)[0];
    expect(talkCaptionStates(cue, project.captions)[0].visibleEnd).toBe(6);
  });
  it('exports plain SRT and progressive ASS from the same states, escaping override injection', () => {
    const project = updateTalkProject(talkFixture(), { revision: 1, edits: [{ cueId: 'first', text: '声织|很好。' }] });
    project.captions.reveal = 'character';
    expect(talkSrt(project)).toContain('声织很好。');
    expect(talkSrt(project)).not.toContain('|');
    const ass = talkAss(project);
    expect(ass).toContain('Dialogue: 0,0:00:00.10');
    expect(ass).toContain('声');
    project.captions.enabled = false;
    expect(talkAss(project)).not.toContain('Dialogue:');
    expect(talkSrt(project)).toContain('声织很好。');
  });
});
