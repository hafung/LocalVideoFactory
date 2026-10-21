import { describe, expect, it } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from '../../shared/edit-plan.js';
import { parseSourceDescription, parseSourceMatches, sourceSpeechCues, sourceWindows, SOURCE_CONTENT_VERSION,
  type SourceCandidate, type SourceContentPlan } from './source-content.js';
import { safeSourceSlice } from './source-selection.js';
import { resolveEditPlan } from './resolver.js';

const candidate = (id: string, startMs: number, endMs: number, extra: Partial<SourceCandidate> = {}): SourceCandidate =>
  ({ id, startMs, endMs, description: id, transcript: '', quality: .9, actions: [], incompleteActions: [], vision: true, ...extra });
function resolve(content: SourceContentPlan, lengths = [3000], originalEnabled = false) {
  const draft = createDraftEditPlan({ id: 'content', script: lengths.map(() => '蓝色画面。').join(''), voiceId: 'vivian', sourceVideoPath: '/source.mp4' });
  draft.audio.originalEnabled = originalEnabled;
  let cursor = 0;
  return resolveEditPlan(draft, { sourceMetadata: { durationMs: 30000, hasAudio: true }, sourceContent: content,
    narration: { audioPath: '/voice.wav', durationMs: lengths.reduce((sum, length) => sum + length, 0),
      segments: lengths.map((length, index) => { const startMs = cursor; cursor += length;
        return { id: draft.scenes[index].id, text: draft.scenes[index].script, startMs, endMs: cursor }; }) } });
}
const content = (candidates: SourceCandidate[], matches: SourceContentPlan['matches'] = {}): SourceContentPlan =>
  ({ index: { version: SOURCE_CONTENT_VERSION, candidates, speech: [], speechReliable: true, warnings: [] }, matches });
const match = (candidateId: string, relevance = .95) => ({ candidateId, relevance, reason: '对应蓝色画面' });

describe('source speech and visual grounding', () => {
  it('keeps a real cut between adjacent complete sentences instead of overlapping protection', () => {
    const cues = sourceSpeechCues([{ offsetMs: 0, durationMs: 6000, result: {
      speechSegments: [{ startMs: 200, endMs: 5700 }], tokens: [
        { text: '第一句。', startMs: 300, endMs: 2000 }, { text: '第二句。', startMs: 2600, endMs: 5600 }
      ] } }], 6000);
    expect(cues).toEqual([{ startMs: 120, endMs: 2300, text: '第一句。' }, { startMs: 2300, endMs: 5780, text: '第二句。' }]);
    expect(safeSourceSlice(candidate('speech', 0, 6000), 2300, [], cues)).toEqual({ startMs: 0, endMs: 2300 });
  });
  it('merges speech crossing chunk overlaps and does not invent speech for silent chunks', () => {
    const cues = sourceSpeechCues([
      { offsetMs: 0, durationMs: 30000, result: { speechSegments: [{ startMs: 28000, endMs: 30000 }], tokens: [{ text: '继续', startMs: 29200, endMs: 29500 }] } },
      { offsetMs: 29000, durationMs: 5000, result: { speechSegments: [{ startMs: 0, endMs: 3000 }], tokens: [{ text: '继续', startMs: 200, endMs: 500 }, { text: '说完。', startMs: 600, endMs: 2800 }] } }
    ], 34000);
    expect(cues).toHaveLength(1); expect(cues[0].text).toBe('继续说完。');
    expect(cues[0].endMs).toBe(32080);
    expect(sourceSpeechCues([{ offsetMs: 0, durationMs: 5000, result: { speechSegments: [], tokens: [] } }], 5000)).toEqual([]);
  });
  it('uses overlapping bounded windows, respects black gaps and extends to sentence ends', () => {
    const windows = sourceWindows([{ startMs: 0, endMs: 25000 }, { startMs: 27000, endMs: 30000 }], [{ startMs: 10000, endMs: 15000 }]);
    expect(windows).toEqual([{ startMs: 0, endMs: 15000 }, { startMs: 11000, endMs: 23000 }, { startMs: 19000, endMs: 25000 }, { startMs: 27000, endMs: 30000 }]);
  });
  it('accepts only valid frame indices and known candidate/scene IDs', () => {
    const times = Array.from({ length: 12 }, (_, index) => 500 + index * 1000);
    const parsed = parseSourceDescription({ description: '蓝色物体', quality: .8,
      moments: [{ firstFrame: 3, lastFrame: 5, description: '拿起物体' }],
      actions: [{ firstFrame: 2, lastFrame: 7, completeStart: true, completeEnd: false }] }, { startMs: 0, endMs: 12000 }, times);
    expect(parsed.moments[0]).toMatchObject({ startMs: 2000, endMs: 8000 });
    expect(parsed.incompleteActions).toEqual([{ startMs: 2000, endMs: 8000 }]);
    expect(() => parseSourceDescription({ description: 'x', quality: .5, actions: [{ firstFrame: 0, lastFrame: 99 }] }, { startMs: 0, endMs: 12000 }, times)).toThrow();
    expect(parseSourceMatches({ matches: [
      { sceneId: 'scene-001', ...match('blue') }, { sceneId: 'invented', ...match('blue') }, { sceneId: 'scene-001', ...match('missing') }
    ] }, ['scene-001'], [candidate('blue', 10000, 14000)])).toEqual({ 'scene-001': [match('blue')] });
  });
});

describe('content-driven source selection', () => {
  it('selects a relevant later clip rather than the first clip and syncs original audio', () => {
    const plan = resolve(content([candidate('red', 0, 5000), candidate('blue', 15000, 20000)], { 'scene-001': [match('blue')] }));
    expect(plan.scenes[0].visual).toMatchObject({ type: 'source', sourceInMs: 15000, sourceOutMs: 18000, sourceMatch: { candidateId: 'blue' } });
    expect(plan.audio.originalSegments).toEqual([{ startMs: 0, endMs: 3000, sourceInMs: 15000, sourceOutMs: 18000 }]);
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });
  it('keeps a complete action across five-second slots, and never reuses source time', () => {
    const source = candidate('blue', 10000, 18000, { actions: [{ startMs: 10000, endMs: 18000 }] });
    const plan = resolve(content([source], { 'scene-001': [match('blue')], 'scene-002': [match('blue')] }), [8000, 3000]);
    expect(plan.scenes.map(scene => scene.visual.type)).toEqual(['source', 'kinetic-text']);
    expect(plan.scenes[0].endMs).toBe(8000); expect(plan.scenes.at(-1)?.endMs).toBe(11000);
  });
  it('supplements weak matches, incomplete actions and utterances that cannot fit', () => {
    for (const source of [candidate('blue', 0, 7000, { incompleteActions: [{ startMs: 0, endMs: 6000 }] }),
      candidate('blue', 0, 7000, { actions: [{ startMs: 0, endMs: 7000 }] })]) {
      expect(resolve(content([source], { 'scene-001': [match('blue')] })).scenes.every(scene => scene.visual.type === 'kinetic-text')).toBe(true);
    }
    expect(resolve(content([candidate('blue', 0, 5000)], { 'scene-001': [match('blue', .3)] })).scenes[0].visual.type).toBe('kinetic-text');
    const protectedSpeech = content([candidate('blue', 0, 7000)], { 'scene-001': [match('blue')] });
    protectedSpeech.index.speech = [{ startMs: 0, endMs: 7000 }];
    expect(resolve(protectedSpeech, [3000], true).scenes[0].visual.type).toBe('kinetic-text');
  });
  it('protects unknown dialogue when retaining original audio, and uses no random fallback', () => {
    const unavailable = content([candidate('blue', 0, 5000)], { 'scene-001': [match('blue')] }); unavailable.index.speechReliable = false;
    expect(resolve(unavailable, [3000], true).scenes[0].visual.type).toBe('kinetic-text');
    expect(resolve(content([candidate('blue', 0, 5000)])).scenes[0].visual.type).toBe('kinetic-text');
  });
});

it('uses observable quality defects and categorical relevance without relying on calibrated model numbers', () => {
  const times = Array.from({ length: 12 }, (_, index) => 500 + index * 1000);
  const clean = parseSourceDescription({ description: '纯蓝色背景', issues: [], quality: 0, actions: [] }, { startMs: 0, endMs: 12000 }, times);
  expect(clean.quality).toBe(1);
  expect(parseSourceDescription({ description: '黑屏', issues: ['black'], actions: [] }, { startMs: 0, endMs: 12000 }, times).quality).toBe(0);
  const matches = parseSourceMatches({ matches: [{ sceneId: 'scene-001', candidateId: 'blue', relation: 'direct', reason: '背景为蓝色' }] },
    ['scene-001'], [candidate('blue', 0, 4000)]);
  expect(matches['scene-001'][0].relevance).toBe(.95);
});
