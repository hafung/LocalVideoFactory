import { expect, it, vi } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from '../../shared/edit-plan.js';
import { resolveEditPlan } from '../composition/resolver.js';
import { LibraryDatabase } from './database.js';
import { listSceneCandidates, sceneSearchIntent } from './scene-candidates.js';
import { applySceneChoice } from './replace-scene.js';
import { SemanticReranker } from './semantic.js';

it('inherits the whole story visual brief for a greeting and offers a second segment of the only video', async () => {
  const database = new LibraryDatabase(':memory:');
  database.upsert({
    id: 'city', filePath: '/media/city.mp4', fingerprint: 'a'.repeat(64), type: 'video', name: 'city night.mp4',
    durationMs: 10000, width: 1920, height: 1080, fps: 30, hasAudio: false,
    tags: ['城市', '夜景'], autoTags: ['城市', '夜景'], manualTags: [], transcript: '',
    license: { status: 'licensed', source: 'pexels' }, createdAt: '2026-09-15T00:00:00.000Z'
  });
  const draft = createDraftEditPlan({ id: 'story', script: '你好', visualBrief: '城市夜景', storyKeywords: ['城市', '夜景'],
    voiceId: 'vivian', keywords: () => ['你好'], aspectRatio: '16:9' });
  const resolved = resolveEditPlan(draft, { narration: { audioPath: '/narration.wav', durationMs: 2000,
    segments: [{ id: 'scene-001', text: '你好', startMs: 0, endMs: 2000, audioPath: '/one.wav' }] } });
  expect(sceneSearchIntent(resolved, resolved.scenes[0])).toMatchObject({ querySource: 'story' });
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
  const initial = await listSceneCandidates(resolved, resolved.scenes[0].id, database,
    { semantic: new SemanticReranker({ embed }) });
  expect(initial.candidates[0].match).toBe('related');
  expect(embed.mock.calls[0][0][0]).toContain('整篇文案：你好');
  expect(embed.mock.calls[0][0][0]).toContain('画面方向：城市夜景');
  const usingCity = applySceneChoice(resolved, resolved.scenes[0].id, { type: 'asset', assetId: 'city', sourceInMs: 0 }, database);
  const next = await listSceneCandidates(usingCity, usingCity.scenes[0].id, database);
  expect(next.candidates.some(candidate => candidate.asset.id === 'city' && candidate.match === 'alternate' &&
    candidate.choice.type === 'asset' && (candidate.choice.sourceInMs ?? 0) >= 2000)).toBe(true);
  const alternate = next.candidates.find(candidate => candidate.match === 'alternate')!;
  const changed = applySceneChoice(usingCity, usingCity.scenes[0].id, alternate.choice, database);
  expect(changed.scenes[0].visual.sourceInMs).toBeGreaterThanOrEqual(2000);
  expect(() => applySceneChoice(usingCity, usingCity.scenes[0].id, { type: 'asset', assetId: 'city', sourceInMs: 1000 }, database))
    .toThrow(/不重叠/);
  expect(EditPlanSchema.safeParse(changed).success).toBe(true);
  database.close();
});

it('filters online-style short local videos by the full selected sentence range', async () => {
  const database = new LibraryDatabase(':memory:');
  for (const [id, durationMs] of [['short', 2000], ['long', 7000]] as const) database.upsert({
    id, filePath: `/media/${id}.mp4`, fingerprint: (id === 'short' ? 'b' : 'c').repeat(64), type: 'video',
    name: `city ${id}`, durationMs, width: 1920, height: 1080, fps: 30, hasAudio: false,
    tags: ['城市'], autoTags: ['城市'], manualTags: [], transcript: '',
    license: { status: 'licensed', source: 'pexels' }, createdAt: '2026-09-15T00:00:00.000Z'
  });
  const draft = createDraftEditPlan({ id: 'range', script: '你好。城市夜景。', visualBrief: '城市夜景',
    voiceId: 'vivian', keywords: () => ['城市'] });
  const plan = resolveEditPlan(draft, { narration: { audioPath: '/narration.wav', durationMs: 4000,
    segments: [
      { id: 'scene-001', text: '你好。', startMs: 0, endMs: 1500, audioPath: '/one.wav' },
      { id: 'scene-002', text: '城市夜景。', startMs: 1500, endMs: 4000, audioPath: '/two.wav' }
    ] } });
  const result = await listSceneCandidates(plan, plan.scenes[0].id, database, { throughSceneId: plan.scenes[1].id });
  expect(result.candidates.some(candidate => candidate.asset.id === 'short')).toBe(false);
  expect(result.candidates.some(candidate => candidate.asset.id === 'long')).toBe(true);
  expect(result.candidates[0].choice).toMatchObject({ throughSceneId: plan.scenes[1].id });
  database.close();
});

it('offers only unused original-video time ranges when replacing a source segment', async () => {
  const database = new LibraryDatabase(':memory:');
  database.upsert({ id: 'source-asset', filePath: '/media/source.mp4', fingerprint: 'd'.repeat(64), type: 'video',
    name: '原视频', durationMs: 6000, width: 1920, height: 1080, fps: 30, hasAudio: false,
    tags: ['城市'], autoTags: ['城市'], manualTags: [], transcript: '',
    license: { status: 'user-owned', source: 'user-import' }, createdAt: '2026-09-15T00:00:00.000Z' });
  const draft = createDraftEditPlan({ id: 'source-edit', script: '城市夜景。继续前进。',
    sourceVideoPath: '/media/source.mp4', voiceId: 'vivian', keywords: () => ['城市'] });
  const plan = resolveEditPlan(draft, { sourceMetadata: { durationMs: 6000, hasAudio: false },
    narration: { audioPath: '/narration.wav', durationMs: 4000,
      segments: [
        { id: 'scene-001', text: '城市夜景。', startMs: 0, endMs: 2000, audioPath: '/one.wav' },
        { id: 'scene-002', text: '继续前进。', startMs: 2000, endMs: 4000, audioPath: '/two.wav' }
      ] } });
  const result = await listSceneCandidates(plan, plan.scenes[0].id, database);
  const sourceChoices = result.candidates.filter(candidate => candidate.asset.id === 'source-asset');
  expect(sourceChoices.every(candidate => candidate.choice.type === 'asset' && candidate.choice.sourceInMs === 2000)).toBe(true);
  expect(sourceChoices.length).toBeGreaterThan(0);
  expect(() => applySceneChoice(plan, plan.scenes[0].id,
    { type: 'asset', assetId: 'source-asset', sourceInMs: 4000 }, database)).toThrow(/已用于其他分镜/);
  const changed = applySceneChoice(plan, plan.scenes[0].id,
    { type: 'asset', assetId: 'source-asset', sourceInMs: 2000 }, database);
  expect(changed.scenes[0].visual.sourceInMs).toBe(2000);
  expect(changed.scenes[1].visual.sourceInMs).toBe(4000);
  database.close();
});
