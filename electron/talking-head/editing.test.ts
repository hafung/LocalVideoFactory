import { describe, expect, it } from 'vitest';
import { talkFixture } from './fixtures.test-support.js';
import { fillerSuggestions, parseTalkSilence, pauseCuts, updateTalkProject } from './editing.js';
import { sourceToTalkTime, talkDuration, talkTimeline, TalkProjectSchema } from '../../shared/talking-head.js';
import { TalkCreateSchema } from '../../shared/talking-head.js';
import { EditPlanSchema, createDraftEditPlan } from '../../shared/edit-plan.js';

describe('independent recorded-speech editing', () => {
  it('rejects reference scripts and keeps both project formats independent', () => {
    expect(() => TalkCreateSchema.parse({ sourcePath: '/input.mp4', script: '参考稿' })).toThrow();
    expect(EditPlanSchema.safeParse(talkFixture()).success).toBe(false);
    const scriptProject = createDraftEditPlan({ id: 'existing-script', script: '原有文案。', voiceId: 'vivian' });
    expect(TalkProjectSchema.safeParse(scriptProject).success).toBe(false);
    expect(scriptProject.template.captionHighlight).toBeUndefined();
  });
  it('unions overlapping removals once and maps source times through restored cuts', () => {
    const project = talkFixture({ cuts: [
      { id: 'a', startMs: 1500, endMs: 3000, applied: true, decided: true, kind: 'manual', reason: 'test' },
      { id: 'b', startMs: 2500, endMs: 3500, applied: true, decided: true, kind: 'manual', reason: 'test' }] });
    expect(talkDuration(project)).toBe(4000);
    expect(talkTimeline(project)).toEqual([
      { startMs: 0, endMs: 1500, outputStartMs: 0, outputEndMs: 1500 },
      { startMs: 3500, endMs: 6000, outputStartMs: 1500, outputEndMs: 4000 }]);
    expect(sourceToTalkTime(project, 3100)).toBe(1500);
    expect(sourceToTalkTime(project, 4000)).toBe(2000);
    const restored = updateTalkProject(project, { revision: 1, cutDecisions: [{ cutId: 'a', applied: false }] });
    expect(talkDuration(restored)).toBe(5000);
    expect(project.cuts[0].applied).toBe(true);
  });

  it('requires both VAD and silence evidence, retaining margins around speech', () => {
    const project = talkFixture();
    const cuts = pauseCuts(project);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ startMs: 2270, endMs: 3570, applied: true, kind: 'pause' });
    expect(pauseCuts({ ...project, silence: [] })).toEqual([]);
    expect(pauseCuts({ ...project, speech: [] })).toEqual([]);
    expect(pauseCuts({ ...project, speech: [{ startMs: 100, endMs: 5000 }] })).toEqual([]);
  });

  it('never automatically removes fillers, meaningful connective words or repeated emphasis', () => {
    const tokens = ['嗯', '然后', '就是', '非常', '非常', '好'].map((text, index) => ({ text,
      startMs: index * 300, endMs: index * 300 + 200, timingSource: 'recognized' as const }));
    const suggestions = fillerSuggestions(tokens, 6000);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ applied: false, kind: 'filler' });
  });

  it('preserves explicit keep choices when strength changes', () => {
    const base = talkFixture(); base.cuts = pauseCuts(base);
    const kept = updateTalkProject(base, { revision: 1, cutDecisions: [{ cutId: base.cuts[0].id, applied: false }] });
    const tight = updateTalkProject(kept, { revision: 2, strength: 'tight' });
    expect(tight.cuts).toEqual(kept.cuts);
    expect(talkDuration(tight)).toBe(6000);
  });

  it('subtitle corrections, deletion and empty captions leave audio, cuts and raw evidence unchanged', () => {
    const project = talkFixture();
    const corrected = updateTalkProject(project, { revision: 1, edits: [{ cueId: 'first', text: '声织|真好。' }, { cueId: 'second', text: '' }] });
    expect(corrected.cues[0].text).toBe('声织|真好。');
    expect(corrected.cues[1].text).toBe('');
    expect(corrected.cues[0].tokens).toEqual(project.cues[0].tokens);
    expect(corrected.cues[0].originalText).toBe(project.cues[0].originalText);
    expect(corrected.source).toEqual(project.source);
    expect(corrected.cuts).toEqual(project.cuts);
    expect(corrected.audio).toEqual(project.audio);
    expect(talkTimeline(corrected)).toEqual(talkTimeline(project));
    expect(project.cues[0].text).toBe('声织很好。');
  });

  it('rejects stale changes, impossible times, all-content deletion and invalid overlay anchors', () => {
    const project = talkFixture();
    expect(() => updateTalkProject(project, { revision: 2 })).toThrow('工程已更新');
    expect(() => updateTalkProject(project, { revision: 1, manualCut: { startMs: 0, endMs: 7000 } })).toThrow();
    expect(() => updateTalkProject(project, { revision: 1, manualCut: { startMs: 0, endMs: 6000 } })).toThrow();
    expect(() => TalkProjectSchema.parse({ ...project, mode: undefined })).toThrow();
    expect(() => updateTalkProject(project, { revision: 1, overlays: [{ id: 'x', cueId: 'missing', type: 'callout', text: 'x', layout: 'pip', position: 'top-right', sourceInMs: 0, enabled: true }] })).toThrow();
  });

  it('parses trailing silence without treating unknown intervals as silence', () => {
    expect(parseTalkSilence('silence_start: 1.2\nsilence_end: 2.1\nsilence_start: 5', 6000))
      .toEqual([{ startMs: 1200, endMs: 2100 }, { startMs: 5000, endMs: 6000 }]);
    expect(parseTalkSilence('silence_end: 3.0', 6000)).toEqual([]);
  });
});
