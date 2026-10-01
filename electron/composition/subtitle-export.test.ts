import { expect, it } from 'vitest';
import { createDraftEditPlan } from '../../shared/edit-plan.js';
import { resolveEditPlan } from './resolver.js';
import { exportAss, exportSrt } from './subtitle-export.js';

it('exports captions on the selected speed timeline and escapes ASS control text', () => {
  const draft = createDraftEditPlan({ id: 'subtitle', script: '你好。', voiceId: 'vivian' });
  const plan = resolveEditPlan(draft, { narration: { audioPath: 'voice.wav', durationMs: 4000,
    segments: [{ id: 'scene-001', text: '你好。', startMs: 0, endMs: 4000, audioPath: 'voice.wav' }] } });
  plan.output.playbackRate = 2;
  plan.captions = [{ id: 'cue', text: '你好{\\pos(0,0)}', startMs: 1000, endMs: 3000, emphasis: [],
    tokens: [{ text: '你好{\\pos(0,0)}', startMs: 1000, endMs: 3000, source: 'estimated' }] }];
  expect(exportSrt(plan)).toContain('00:00:00,500 --> 00:00:01,500');
  const ass = exportAss(plan);
  expect(ass).toContain('0:00:00.50,0:00:01.50');
  expect(ass).toContain(`PlayResX: ${plan.canvas.width}`);
  expect(ass).toContain('｛＼pos(0,0)｝');
  expect(ass).not.toContain('{\\pos(0,0)}');
});
