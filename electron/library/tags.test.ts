import { describe, expect, it } from 'vitest';
import { MediaAssetSchema } from '../../shared/library.js';
import { refreshedAutomaticTags } from './tags.js';

describe('retagging downloaded media', () => {
  it.each(['pexels', 'openverse'])('preserves %s provider tags and omits generated filenames', source => {
    const asset = MediaAssetSchema.parse({ id: 'music',
      filePath: '/downloads/openverse-0b2b8bcb-35f4-4a8e-852b-92a50f7c91e8.mp3', fingerprint: 'a'.repeat(64),
      name: 'Piano music', type: 'audio', hasAudio: true, tags: [], autoTags: ['ambient', 'relaxing', source, '12345'],
      license: { source, status: 'licensed' }, createdAt: '2026-10-28T00:00:00.000Z' });
    const tags = refreshedAutomaticTags(asset);
    expect(tags).toEqual(expect.arrayContaining(['钢琴', '音频', 'ambient', 'relaxing']));
    expect(tags).not.toContain(source);
    expect(tags).not.toContain('12345');
    expect(tags.join(' ')).not.toContain('0b2b8bcb');
  });
});
