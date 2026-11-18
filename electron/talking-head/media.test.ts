import { describe, expect, it } from 'vitest';
import { TalkProjectSchema, TalkVoiceAuditionSchema, talkTimeline } from '../../shared/talking-head.js';
import { updateTalkProject } from './editing.js';
import { normalizeTalkTokens, talkAudioFilter } from './media.js';
import { talkFixture } from './fixtures.test-support.js';

describe('recorded-speech media', () => {
  it('keeps deliberate repeated words while owning overlapping chunk boundaries once', () => {
    const result = { tokens: [
      { text: '非常', startMs: 28000, endMs: 28200 }, { text: '非常', startMs: 28300, endMs: 28600 },
      { text: '好', startMs: 29100, endMs: 29400 }] };
    expect(normalizeTalkTokens(result, 0, 30000, 60000, true, false).map(token => token.text)).toEqual(['非常', '非常']);
    expect(normalizeTalkTokens({ tokens: [{ text: '非常', startMs: 0, endMs: 600 },
      { text: '好', startMs: 1100, endMs: 1400 }] }, 28000, 30000, 60000, false, false).map(token => token.text)).toEqual(['好']);
  });
  it('uses one source for both sides of a cut and fades without shortening audio', () => {
    const project = talkFixture({ cuts: [{ id: 'cut', startMs: 2000, endMs: 3500, applied: true, decided: true, kind: 'manual', reason: 'test' }] });
    const filter = talkAudioFilter(talkTimeline(project));
    expect(filter).toContain('[0:a]asplit=2');
    expect(filter).toContain('atrim=start=0:end=2');
    expect(filter).toContain('atrim=start=3.5:end=6');
    expect(filter).toContain('concat=n=2:v=0:a=1');
    expect(filter).not.toContain('acrossfade');
  });
  it('opens older projects with enhancement off and preserves cuts and captions when the preset changes', () => {
    const current = talkFixture();
    const { voiceEnhancement, ...oldAudio } = current.audio;
    const project = TalkProjectSchema.parse({ ...current, audio: oldAudio });
    expect(project.audio.voiceEnhancement).toBe('off');

    const enhanced = updateTalkProject(project, { revision: project.revision, audio: { ...project.audio, voiceEnhancement: 'warm' } });
    expect(enhanced.audio).toEqual({ ...project.audio, voiceEnhancement: 'warm' });
    expect(talkTimeline(enhanced)).toEqual(talkTimeline(project));
    expect(enhanced.cues).toEqual(project.cues);
  });
  it('rejects invalid audition presets and times', () => {
    expect(TalkVoiceAuditionSchema.safeParse({ revision: 1, preset: 'off', atMs: 0 }).success).toBe(false);
    expect(TalkVoiceAuditionSchema.safeParse({ revision: 1, preset: 'natural', atMs: -1 }).success).toBe(false);
  });
});
