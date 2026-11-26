import { expect, it, vi } from 'vitest';
import { createDraftEditPlan, EditPlanSchema } from '../../shared/edit-plan.js';
import type { MediaAsset } from '../../shared/library.js';
import { resolveEditPlan } from '../composition/resolver.js';
import { fillOnlineMedia, type AutomaticMediaProvider } from './automatic-media.js';

function plan() {
  const draft = createDraftEditPlan({ id: 'auto', script: '产品细节。', voiceId: 'vivian' });
  draft.scenes[0].visual.intent.searchQuery = 'close up product';
  return resolveEditPlan(draft, { narration: { audioPath: '/voice.wav', durationMs: 5000,
    segments: [{ id: 'scene-001', text: '产品细节。', startMs: 0, endMs: 5000 }] } });
}
function online(id: string, type: 'video' | 'image', durationMs = 5000) {
  return { id, type, durationMs, name: id, sourceUrl: `https://www.pexels.com/${id}/` };
}
function provider(items: ReturnType<typeof online>[]): AutomaticMediaProvider {
  return { acquire: vi.fn(async ({ types }, _remaining, excluded, signal) => {
    signal.throwIfAborted();
    const item = items.find(item => types.includes(item.type) && !excluded.has(item.sourceUrl));
    if (!item) return {};
    excluded.add(item.sourceUrl);
    return { asset: { id: item.id, type: item.type, durationMs: item.durationMs,
      license: { status: 'licensed', source: 'pexels' } } as MediaAsset };
  }) };
}
it('uses shorter videos as a montage before searching images', async () => {
  const api = provider([online('v1', 'video', 3000), online('v2', 'video', 2500), online('i1', 'image')]);
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {});
  expect(result.scenes.map(scene => [scene.visual.type, scene.endMs - scene.startMs])).toEqual([['video', 3000], ['video', 2000]]);
  expect(api.acquire).toHaveBeenCalledTimes(2);
  expect(api.acquire).toHaveBeenCalledWith({ query: 'close up product', types: ['video'], orientation: 'portrait', minDurationMs: 1000 },
    5000, expect.any(Set), expect.any(AbortSignal));
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
  const acquire = api.acquire;
  api.acquire = vi.fn(async (request, remaining, excluded, signal) =>
    request.types[0] === 'video' ? { notice: 'timeout' } : acquire(request, remaining, excluded, signal));
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {});
  expect(result.scenes[0].visual.type).toBe('image');
  expect(result.scenes.at(-1)?.visual.type).toBe('kinetic-text');
  expect(result.warnings?.join(' ')).toContain('timeout');
  expect(EditPlanSchema.safeParse(result).success).toBe(true);
});
it('does not repeat media already in use, and honours cancellation', async () => {
  const item = online('v1', 'video'); const api = provider([item]);
  const result = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {}, [item.sourceUrl]);
  expect(result.scenes[0].visual.type).toBe('kinetic-text');
  const controller = new AbortController(); controller.abort();
  await expect(fillOnlineMedia(plan(), api, controller.signal, () => {})).rejects.toThrow();
});

it('can search videos and still images in separate passes around local image selection', async () => {
  const api = provider([online('i1', 'image')]);
  const videos = await fillOnlineMedia(plan(), api, new AbortController().signal, () => {}, [], { types: ['video'] });
  expect(api.acquire).toHaveBeenCalledTimes(1);
  expect(videos.scenes[0].visual.type).toBe('kinetic-text');
  const images = await fillOnlineMedia(videos, api, new AbortController().signal, () => {}, [], { types: ['image'] });
  expect(api.acquire).toHaveBeenCalledTimes(3);
  expect(images.scenes[0].visual.type).toBe('image');
});
