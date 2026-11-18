import { TalkProjectSchema, type TalkProject } from '../../shared/talking-head.js';

export function talkFixture(overrides: Partial<TalkProject> = {}): TalkProject {
  return TalkProjectSchema.parse({ schemaVersion: 1, mode: 'talking-head', id: 'b2d4851b-a860-4e33-b81c-f8127ac5485b',
    revision: 1, createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
    source: { name: '口播.mp4', originalPath: '/input/口播.mp4', durationMs: 6000, width: 720, height: 1280 },
    strength: 'natural', captions: { enabled: true, reveal: 'phrase', highlight: 'color', position: 'bottom' },
    cues: [{ id: 'first', startMs: 100, endMs: 1800, originalText: '声织很好。', text: '声织很好。',
      tokens: [{ text: '声', startMs: 100, endMs: 400, timingSource: 'recognized' },
        { text: '织', startMs: 400, endMs: 700, timingSource: 'recognized' },
        { text: '很', startMs: 900, endMs: 1200, timingSource: 'recognized' },
        { text: '好', startMs: 1300, endMs: 1800, timingSource: 'recognized' }] },
    { id: 'second', startMs: 4000, endMs: 5000, originalText: '谢谢。', text: '谢谢。',
      tokens: [{ text: '谢', startMs: 4000, endMs: 4400, timingSource: 'recognized' },
        { text: '谢', startMs: 4500, endMs: 5000, timingSource: 'recognized' }] }],
    cuts: [], speech: [{ startMs: 100, endMs: 1800 }, { startMs: 4000, endMs: 5000 }],
    silence: [{ startMs: 1900, endMs: 3900 }], overlays: [], audio: { voiceVolume: 1, bgmVolume: .12, ducking: true },
    warnings: [], ...overrides });
}
