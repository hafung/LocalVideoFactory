import { expect, it, vi } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from '../../shared/edit-plan.js';
import type { OnlineAsset, MediaAsset } from '../../shared/library.js';
import { resolveEditPlan } from '../composition/resolver.js';
import { fillOnlineMedia, type AutomaticMediaProvider } from './automatic-media.js';

function plan() {
  const draft = createDraftEditPlan({ id: 'auto', script: '产品细节。', voiceId: 'vivian' });
  draft.scenes[0].visual.intent.searchQuery = 'close up product';
  return resolveEditPlan(draft, { narration: { audioPath: '/voice.wav', durationMs: 5000,
    segments: [{ id: 'scene-001', text: '产品细节。', startMs: 0, endMs: 5000 }] } });
}
function online(id: string, type: 'video' | 'image', durationMs = 5000): OnlineAsset {
  return { id, type, durationMs, name: id, sourceUrl: `https://www.pexels.com/${id}/`, thumbnailUrl: '', downloadUrl: '', author: 'a', width: 1080, height: 1920, tags: [] };
}
function provider(items: OnlineAsset[]): AutomaticMediaProvider {
  return { search: vi.fn(async (_query, type) => items.filter(item => item.type === type)),
    download: vi.fn(async id => { const item = items.find(item => item.id === id)!;
      return { id: item.id, type: item.type, durationMs: item.durationMs, license: { status: 'licensed', source: 'pexels' } } as MediaAsset; }) };
}
it('uses shorter videos as a montage before searching images', async () => {
  const api = provider([online('v1', 'video', 3000), online('v2', 'video', 2500), online('i1', 'image')]);
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {});
  expect(result.scenes.map(scene => [scene.visual.type, scene.endMs - scene.startMs])).toEqual([['video', 3000], ['video', 2000]]);
  expect(api.search).toHaveBeenCalledTimes(1);
  expect(api.search).toHaveBeenCalledWith('close up product', 'video', 'portrait', expect.any(AbortSignal));
  expect(EditPlanSchema.safeParse(result).success).toBe(true);
});
it('keeps every automatic image at two seconds or less and preserves search intent', async () => {
  const api = provider([online('i1', 'image'), online('i2', 'image'), online('i3', 'image')]);
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {});
  expect(result.scenes.map(scene => scene.endMs - scene.startMs)).toEqual([2000, 2000, 1000]);
  expect(new Set(result.scenes.map(scene => scene.visual.assetId)).size).toBe(3);
  expect(result.scenes.every(scene => scene.visual.intent.searchQuery === 'close up product')).toBe(true);
  expect(EditPlanSchema.safeParse(result).success).toBe(true);
});
it('continues after video search fails and records the visible fallback warning', async () => {
  const api = provider([online('i1', 'image')]);
  vi.mocked(api.search).mockImplementation(async (_query, type) => { if (type === 'video') throw new Error('timeout'); return [online('i1', 'image')]; });
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {});
  expect(result.scenes[0].visual.type).toBe('image');
  expect(result.scenes.at(-1)?.visual.type).toBe('kinetic-text');
  expect(result.warnings?.join(' ')).toContain('timeout');
  expect(EditPlanSchema.safeParse(result).success).toBe(true);
});
it('does not repeat media already in use, and honours cancellation', async () => {
  const item = online('v1', 'video'); const api = provider([item]);
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {}, [item.sourceUrl]);
  expect(api.download).not.toHaveBeenCalled();
  expect(result.scenes[0].visual.type).toBe('kinetic-text');
  const controller = new AbortController(); controller.abort();
  await expect(fillOnlineMedia(plan(), api, controller.signal, () => {})).rejects.toThrow();
});

it('can search videos and still images in separate passes around local image selection', async () => {
  const api = provider([online('i1', 'image')]);
  const videos = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {}, [], { types: ['video'] });
  expect(api.search).toHaveBeenCalledTimes(1);
  expect(videos.scenes[0].visual.type).toBe('kinetic-text');
  const images = await fillOnlineMedia(videos, api, new AbortController().signal, () => {}, [], { types: ['image'] });
  expect(api.search).toHaveBeenCalledTimes(2);
  expect(images.scenes[0].visual.type).toBe('image');
});
