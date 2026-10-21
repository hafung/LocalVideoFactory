import { describe, expect, it } from 'vitest';
import { createDraftEditPlan } from '../../shared/edit-plan.js';
import type { MediaAsset } from '../../shared/library.js';
import { resolveEditPlan } from '../composition/resolver.js';
import { LibraryDatabase } from './database.js';
import { selectBroll, fillShortLocalVideos } from './selector.js';

it('keeps two short related sentences on one continuous B-roll shot', () => {
  const database = new LibraryDatabase(':memory:');
  for (const id of ['a', 'b']) database.upsert({
    id, filePath: `/media/${id}.mp4`, fingerprint: id.repeat(64), type: 'video', name: `产品-${id}.mp4`,
    durationMs: 5000, width: 1080, height: 1920, fps: 30, hasAudio: false, tags: ['产品'], autoTags: [], manualTags: ['产品'], transcript: '',
    license: { status: 'licensed', source: 'test' }, createdAt: '2026-09-15T00:00:00.000Z'
  } satisfies MediaAsset);
  const draft = createDraftEditPlan({ id: 'select', script: '产品第一句。产品第二句。', voiceId: 'vivian', keywords: () => ['产品'] });
  const plan = resolveEditPlan(draft, { narration: {
    audioPath: '/narration.wav', durationMs: 2400,
    segments: [
      { id: 'scene-001', text: '产品第一句。', startMs: 0, endMs: 1200, audioPath: '/one.wav' },
      { id: 'scene-002', text: '产品第二句。', startMs: 1200, endMs: 2400, audioPath: '/two.wav' }
    ]
  }});
  const selected = selectBroll(plan, database);
  expect(selected.scenes.map(scene => scene.visual.assetId)).toEqual(['a', 'a']);
  expect(selected.scenes.map(scene => scene.visual.sourceInMs)).toEqual([0, 1200]);
  database.close();
});

it('uses distinct nonoverlapping ranges when the library has only one long video', () => {
  const database = new LibraryDatabase(':memory:');
  database.upsert({
    id: 'only', filePath: '/media/only.mp4', fingerprint: 'c'.repeat(64), type: 'video', name: '城市夜景.mp4',
    durationMs: 9000, width: 1920, height: 1080, fps: 30, hasAudio: false,
    tags: ['城市', '夜景'], autoTags: ['城市', '夜景'], manualTags: [], transcript: '',
    license: { status: 'licensed', source: 'pexels' }, createdAt: '2026-09-15T00:00:00.000Z'
  });
  const draft = createDraftEditPlan({ id: 'one-video', script: '你好。城市夜景。', visualBrief: '城市夜景',
    storyKeywords: ['城市', '夜景'], voiceId: 'vivian', keywords: text => text.includes('你好') ? ['你好'] : ['城市'] });
  const plan = resolveEditPlan(draft, { narration: { audioPath: '/narration.wav', durationMs: 4000,
    segments: [
      { id: 'scene-001', text: '你好。', startMs: 0, endMs: 2000, audioPath: '/one.wav' },
      { id: 'scene-002', text: '城市夜景。', startMs: 2000, endMs: 4000, audioPath: '/two.wav' }
    ] } });
  const selected = selectBroll(plan, database);
  expect(selected.scenes.map(scene => scene.visual.assetId)).toEqual(['only', 'only']);
  expect(selected.scenes.map(scene => scene.visual.sourceInMs)).toEqual([0, 2000]);
  database.close();
});

it('does not replay the imported original video after its timeline ends', () => {
  const database = new LibraryDatabase(':memory:');
  database.upsert({
    id: 'source-asset', filePath: '/media/source.mp4', fingerprint: 'd'.repeat(64), type: 'video', name: '城市夜景.mp4',
    durationMs: 1700, width: 1920, height: 1080, fps: 30, hasAudio: false,
    tags: ['城市'], autoTags: ['城市'], manualTags: [], transcript: '',
    license: { status: 'user-owned', source: 'user-import' }, createdAt: '2026-09-15T00:00:00.000Z'
  });
  const draft = createDraftEditPlan({ id: 'source-fallback', script: '城市夜景。欢迎来到城市。',
    sourceVideoPath: '/media/source.mp4', voiceId: 'vivian', keywords: () => ['城市'] });
  const plan = resolveEditPlan(draft, { sourceMetadata: { durationMs: 1700, hasAudio: false },
    narration: { audioPath: '/narration.wav', durationMs: 3000,
      segments: [
        { id: 'scene-001', text: '城市夜景。', startMs: 0, endMs: 1200, audioPath: '/one.wav' },
        { id: 'scene-002', text: '欢迎来到城市。', startMs: 1200, endMs: 3000, audioPath: '/two.wav' }
      ] } });
  const selected = selectBroll(plan, database);
  expect(selected.scenes.map(scene => scene.visual.type)).toEqual(['source', 'source', 'kinetic-text']);
  expect(selected.scenes.at(-1)?.startMs).toBe(1700);
  database.close();
});

it('uses a shorter local video before a long gap falls back to online still images', () => {
  const database = new LibraryDatabase(':memory:');
  database.upsert({ id: 'short', filePath: '/short.mp4', fingerprint: 'e'.repeat(64), type: 'video', name: '产品',
    durationMs: 3000, width: 1080, height: 1920, hasAudio: false, tags: ['产品'], autoTags: [], manualTags: [], transcript: '',
    license: { status: 'licensed', source: 'test' }, createdAt: '2026-10-21T00:00:00.000Z' });
  const draft = createDraftEditPlan({ id: 'short-local', script: '产品展示。', voiceId: 'vivian', keywords: () => ['产品'] });
  const plan = resolveEditPlan(draft, { narration: { audioPath: '/voice.wav', durationMs: 5000,
    segments: [{ id: 'scene-001', text: '产品展示。', startMs: 0, endMs: 5000 }] } });
  const result = fillShortLocalVideos(selectBroll(plan, database), database);
  expect(result.scenes.map(scene => [scene.visual.type, scene.endMs - scene.startMs])).toEqual([['video', 3000], ['kinetic-text', 2000]]);
  expect(fillShortLocalVideos(result, database)).toBe(result);
  database.close();
});

it('prefers an equally relevant asset that was not used in the previous video', () => {
  const database = new LibraryDatabase(':memory:');
  for (const id of ['a', 'b']) database.upsert({ id, filePath: `/${id}.mp4`, fingerprint: id.repeat(64), type: 'video', name: '产品',
    durationMs: 5000, width: 1080, height: 1920, hasAudio: false, tags: ['产品'], autoTags: [], manualTags: [], transcript: '',
    license: { status: 'licensed', source: 'test' }, createdAt: '2026-10-21T00:00:00.000Z' });
  const draft = createDraftEditPlan({ id: 'recent', script: '产品展示。', voiceId: 'vivian', keywords: () => ['产品'] });
  const plan = resolveEditPlan(draft, { narration: { audioPath: '/voice.wav', durationMs: 2000,
    segments: [{ id: 'scene-001', text: '产品展示。', startMs: 0, endMs: 2000 }] } });
  expect(selectBroll(plan, database, undefined, { avoidAssetIds: ['a'] }).scenes[0].visual.assetId).toBe('b');
  database.close();
});
