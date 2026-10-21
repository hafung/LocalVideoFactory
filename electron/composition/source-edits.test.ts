import { describe, expect, it } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from '../../shared/edit-plan.js';
import { resolveEditPlan } from './resolver.js';
import { parseSourceAnalysis } from './source-edits.js';

function resolve(sourceDurationMs: number, lengths: number[], ranges?: Array<{ startMs: number; endMs: number }>) {
  const draft = createDraftEditPlan({ id: 'source-edit', script: lengths.map(() => '产品细节。').join(''), voiceId: 'vivian', sourceVideoPath: '/source.mp4' });
  draft.scenes.forEach(scene => { scene.visual.intent.searchQuery = 'product details'; scene.visual.intent.planningSource = 'llm'; });
  let cursor = 0;
  return resolveEditPlan(draft, { sourceMetadata: { durationMs: sourceDurationMs, hasAudio: true }, sourceRanges: ranges,
    narration: { audioPath: '/voice.wav', durationMs: lengths.reduce((a, b) => a + b),
      segments: lengths.map((length, i) => { const startMs = cursor; cursor += length;
        return { id: draft.scenes[i].id, text: draft.scenes[i].script, startMs, endMs: cursor }; }) } });
}

describe('source montage', () => {
  it('uses the beginning and end of a long source while keeping source order and exact narration duration', () => {
    const plan = resolve(60_000, [5000, 5000]);
    expect(plan.scenes.map(scene => [scene.visual.sourceInMs, scene.visual.sourceOutMs])).toEqual([[0, 5000], [55000, 60000]]);
    expect(plan.audio.originalSegments).toEqual([
      { startMs: 0, endMs: 5000, sourceInMs: 0, sourceOutMs: 5000 },
      { startMs: 5000, endMs: 10000, sourceInMs: 55000, sourceOutMs: 60000 }
    ]);
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('uses a short source once, skips black gaps, and preserves AI search intent in the supplement', () => {
    const plan = resolve(9000, [6000, 6000], [{ startMs: 0, endMs: 4000 }, { startMs: 5000, endMs: 9000 }]);
    const source = plan.scenes.filter(scene => scene.visual.type === 'source');
    expect(source.reduce((sum, scene) => sum + scene.endMs - scene.startMs, 0)).toBe(8000);
    expect(source.every(scene => scene.visual.sourceOutMs! <= 4000 || scene.visual.sourceInMs! >= 5000)).toBe(true);
    const fallback = plan.scenes.filter(scene => scene.visual.type === 'kinetic-text');
    expect(fallback.reduce((sum, scene) => sum + scene.endMs - scene.startMs, 0)).toBe(4000);
    expect(fallback.every(scene => scene.visual.intent.searchQuery === 'product details' && scene.originSceneId)).toBe(true);
    expect(plan.scenes.at(-1)?.endMs).toBe(12000);
    expect(EditPlanSchema.safeParse(plan).success).toBe(true);
  });

  it('cuts long narration scenes into bounded shots and handles all-black source', () => {
    const plan = resolve(60000, [12000]);
    expect(plan.scenes).toHaveLength(3);
    expect(plan.scenes.every(scene => scene.endMs - scene.startMs <= 5000)).toBe(true);
    const black = resolve(2000, [6000], []);
    expect(black.scenes.every(scene => scene.visual.type === 'kinetic-text')).toBe(true);
    expect(black.audio.originalSegments).toEqual([]);
  });

  it('maintains integer, nonoverlapping source ranges and a gapless output across duration ratios', () => {
    for (const sourceMs of [1, 1700, 10001, 99999]) for (const lengths of [[1200, 1800], [5311, 1703, 12499]]) {
      const plan = resolve(sourceMs, lengths);
      let previous = 0;
      for (const scene of plan.scenes.filter(scene => scene.visual.type === 'source')) {
        expect(scene.visual.sourceInMs!).toBeGreaterThanOrEqual(previous);
        expect(scene.visual.sourceOutMs!).toBeLessThanOrEqual(sourceMs);
        previous = scene.visual.sourceOutMs!;
      }
      expect(EditPlanSchema.safeParse(plan).success).toBe(true);
    }
  });

  it('parses shot boundaries and removes nearly full black intervals', () => {
    const ranges = parseSourceAnalysis('pts_time:1\nblack_start:1 black_end:2 black_duration:1\npts_time:2\npts_time:4', 6000);
    expect(ranges).toEqual([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 4000 }, { startMs: 4000, endMs: 6000 }]);
    expect(parseSourceAnalysis('black_start:0 black_end:8.75 black_duration:8.75', 9000)).toEqual([]);
  });
});
