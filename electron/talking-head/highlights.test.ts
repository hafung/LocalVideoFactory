import { describe, expect, it } from 'vitest';
import { talkCanvas, talkTimeline, type TalkHighlight } from '../../shared/talking-head.js';
import { talkFixture } from './fixtures.test-support.js';
import { editTalkHighlight, findTalkHighlights, highlightProject } from './highlights.js';
import { talkAss } from './captions.js';

describe('independent talking-head highlights', () => {
  it('matches subtitle IDs, requires an evidence quote and deduplicates near-identical proposals', async () => {
    const base = talkFixture();
    const project = talkFixture({ source: { ...base.source, durationMs: 30_000 }, cues: [base.cues[0],
      { ...base.cues[1], startMs: 20_000, endMs: 22_000, tokens: [] }] });
    const clip = { from: 'first', through: 'second', title: '演示口播', reason: '讲了 8 个步骤', quote: '声织很好', score: .9 };
    const result = await findTalkHighlights(project, '', async () => ({ clips: [clip, { ...clip, score: .8 },
      { ...clip, from: 'unknown', score: .99 }, { ...clip, quote: '凭空补充的效果', score: .99 }] }), new AbortController().signal);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: '演示口播', reason: '建议试听这段连续表达。', evidence: '声织很好',
      confirmed: false, startMs: 0, endMs: 22_150 });
    expect(await findTalkHighlights(project, '', async () => ({ clips: [] }), new AbortController().signal)).toEqual([]);
  });

  it('reuses confirmed edits in the clip without changing the master or the output dimensions', () => {
    const base = talkFixture({ framing: { aspect: '1:1', layout: 'fit', x: 50, y: 50 },
      cuts: [{ id: 'pause', startMs: 2100, endMs: 3200, reason: '停顿', kind: 'pause', applied: true, decided: true }] });
    const clip: TalkHighlight = { id: '91c0c411-794a-469a-947a-62003624269f', startMs: 100, endMs: 5000, title: '片段',
      reason: '此前的理由', evidence: '跟随原话', origin: 'model', confirmed: false };
    const derived = highlightProject(base, clip);
    expect(talkTimeline(derived)).toEqual([{ startMs: 100, endMs: 2100, outputStartMs: 0, outputEndMs: 2000 },
      { startMs: 3200, endMs: 5000, outputStartMs: 2000, outputEndMs: 3800 }]);
    expect(base.cuts.map(cut => cut.id)).toEqual(['pause']);
    expect(talkCanvas(derived)).toEqual({ width: 1080, height: 1080 });
    expect(talkAss(derived)).toContain('PlayResX: 1080\nPlayResY: 1080');
    expect(editTalkHighlight(base, clip, { ...clip, startMs: 150 })).toMatchObject({ confirmed: true, evidence: '', reason: '' });
    expect(() => highlightProject(base, { ...clip, startMs: 2200, endMs: 3100 })).toThrow(/半秒/u);
  });
});
