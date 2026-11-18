import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MediaAssetSchema } from '../../shared/library.js';
import { resolveTalkAssets } from './assets.js';
import { talkFixture } from './fixtures.test-support.js';

it('recovers a preview after library files disappear and preserves choices for replacement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voxweave-talk-assets-'));
  try {
    const project = talkFixture({
      overlays: [
        { id: 'missing', cueId: 'first', type: 'image', assetId: 'image', text: '', layout: 'cover',
          position: 'top-left', sourceInMs: 0, enabled: true },
        { id: 'graphic', cueId: 'second', type: 'callout', text: '说明', layout: 'pip',
          position: 'top-right', sourceInMs: 0, enabled: true }
      ],
      audio: { voiceVolume: 1, bgmAssetId: 'music', bgmVolume: .2, ducking: true, voiceEnhancement: 'off' }
    });
    const imagePath = path.join(dir, 'image.png');
    const asset = MediaAssetSchema.parse({ id: 'image', filePath: imagePath, type: 'image', name: '图片',
      fingerprint: '0'.repeat(64), hasAudio: false, tags: [], license: { status: 'user-owned', source: 'local' },
      createdAt: project.createdAt });
    const lookup = (id: string) => id === asset.id ? asset : undefined;
    const fallback = await resolveTalkAssets(project, lookup);
    expect(fallback.project.overlays.map(item => item.id)).toEqual(['graphic']);
    expect(fallback.project.audio.bgmAssetId).toBeUndefined();
    expect(fallback.warnings).toHaveLength(2);
    expect(project.overlays[0].assetId).toBe('image');
    expect(project.audio.bgmAssetId).toBe('music');
    await writeFile(imagePath, 'render fixture');
    const recovered = await resolveTalkAssets(project, lookup);
    expect(recovered.project.overlays).toEqual(project.overlays);
    expect(recovered.resolve('image').filePath).toBe(imagePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
