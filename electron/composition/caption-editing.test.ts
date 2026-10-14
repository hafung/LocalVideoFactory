import { expect, it } from 'vitest';
import { createDraftEditPlan } from '../../shared/edit-plan.js';
import { resolveEditPlan } from './resolver.js';
import { manualCaptionUnits, updateCaptionHighlight } from './caption-editing.js';

const draft = createDraftEditPlan({ id: 'edit', voiceId: 'vivian', script: '三个步骤。', captionHighlight: 'phrase' });
const plan = resolveEditPlan(draft, { narration: { audioPath: 'voice.wav', durationMs: 1600,
  segments: [{ id: 'scene-001', text: '三个步骤。', startMs: 0, endMs: 1600 }] } });

it('saves manual groups and switches modes without changing audio or token times', () => {
  const cue = plan.captions[0];
  const changed = updateCaptionHighlight(plan, 'phrase', [{ cueId: cue.id, text: '三个|步骤。' }]);
  expect(changed.captions[0].highlightUnits!.map(unit => unit.text)).toEqual(['三个', '步骤。']);
  expect(changed.captions[0].tokens).toEqual(cue.tokens);
  expect(changed.narration).toEqual(plan.narration);
  const disabled = updateCaptionHighlight(changed, 'none');
  expect(disabled.captions[0].highlightUnits).toEqual([]);
  expect(updateCaptionHighlight(disabled, 'phrase').captions[0].highlightUnits).toEqual(changed.captions[0].highlightUnits);
});
it('marks splits within a word as estimated and rejects text changes', () => {
  const cue = plan.captions[0];
  const units = manualCaptionUnits(cue, '三|个步骤。');
  expect(units[0].timingSource).toBe('estimated');
  expect(units[0].endMs).toBe(units[1].startMs);
  expect(() => manualCaptionUnits(cue, '三个|技巧。')).toThrow('保留字幕原文');
  expect(() => updateCaptionHighlight(plan, 'phrase', [{ cueId: 'missing', text: '' }])).toThrow('无效');
});
