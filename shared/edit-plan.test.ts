import { describe, expect, it } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from './edit-plan.js';

describe('EditPlanSchema', () => {
  it('creates a deterministic draft whose scenes cover the estimated narration', () => {
    const plan = createDraftEditPlan({
      id: 'plan-1',
      script: '产品很好，却一直卖不出去？问题可能是表达方式。',
      voiceId: 'vivian',
      aspectRatio: '9:16',
      keywords: text => text.includes('产品') ? ['产品', '电商'] : ['表达方式'],
      now: new Date('2026-09-14T00:00:00.000Z')
    });

    expect(plan.status).toBe('draft');
    expect(plan.canvas).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(plan.scenes).toHaveLength(2);
    expect(plan.scenes[0].startMs).toBe(0);
    expect(plan.scenes.at(-1)?.endMs).toBe(plan.narration.estimatedDurationMs);
    expect(plan.scenes[0].visual.intent.keywords).toEqual(['产品', '电商']);
  });

  it('prioritizes the optional source video without making it mandatory', () => {
    const withoutSource = createDraftEditPlan({ id: 'one', script: '只提供文案也可以。', voiceId: 'vivian' });
    const withSource = createDraftEditPlan({ id: 'two', script: '也可以提供原始视频。', voiceId: 'vivian', sourceVideoPath: 'D:\\clips\\raw.mp4' });

    expect(withoutSource.scenes[0].visual.type).toBe('kinetic-text');
    expect(withSource.scenes[0].visual).toMatchObject({ type: 'source', assetId: 'source-video' });
  });

  it('keeps line-wrapped narration together without merging its visual scenes', () => {
    const plan = createDraftEditPlan({ id: 'wrapped', script: '第一句。\n第二句！\n第三句？', voiceId: 'vivian' });
    expect(plan.scenes.map(scene => scene.script)).toEqual(['第一句。', '第二句！', '第三句？']);
    expect(plan.narration.chunks).toHaveLength(1);
    expect(plan.narration.chunks![0].sceneIds).toEqual(plan.scenes.map(scene => scene.id));
  });

  it('rejects overlapping scenes', () => {
    const plan = createDraftEditPlan({ id: 'plan-2', script: '第一句。第二句。', voiceId: 'vivian' });
    const invalid = structuredClone(plan);
    invalid.scenes[1].startMs = invalid.scenes[0].endMs - 1;
    expect(EditPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires real narration data after the draft stage', () => {
    const plan = createDraftEditPlan({ id: 'plan-3', script: '准备生成。', voiceId: 'vivian' });
    expect(EditPlanSchema.safeParse({ ...plan, status: 'resolved' }).success).toBe(false);
  });

  it('keeps old projects muted by default and persists independent track levels', () => {
    const plan = createDraftEditPlan({ id: 'audio', script: '保留现场声音。', voiceId: 'vivian', sourceVideoPath: 'source.mp4' });
    const { audio: _oldField, ...oldPlan } = plan;
    expect(EditPlanSchema.parse(oldPlan).audio).toEqual({ narrationVolume: 1, originalEnabled: false, originalVolume: .35, originalDucking: true });
    expect(EditPlanSchema.parse({ ...plan, audio: { narrationVolume: .8, originalEnabled: true, originalVolume: .5, originalDucking: false } }).audio.originalEnabled).toBe(true);
    expect(EditPlanSchema.safeParse({ ...plan, audio: { ...plan.audio, originalVolume: 2.1 } }).success).toBe(false);
  });
});
