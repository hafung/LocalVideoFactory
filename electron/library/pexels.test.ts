import { expect, it, vi } from 'vitest';
import { pexelsAdapter } from './pexels.js';

it('maps Chinese queries and supplies the Pexels author, license and tags', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ photos: [{
    id: 123, width: 1600, height: 900, url: 'https://www.pexels.com/photo/123/', photographer: 'Example author',
    alt: 'Office team', src: { medium: 'https://images.pexels.com/photos/123/small.jpeg', large2x: 'https://images.pexels.com/photos/123/large.jpeg' }
  }] }));
  const query = pexelsAdapter.query('办公室');
  expect(query).toBe('office');
  const result = await pexelsAdapter.search({ query, type: 'image', page: 1 }, { key: 'test-key', tier: 'demo' }, request);
  expect(result.items[0].license).toMatchObject({ author: 'Example author', licenseUrl: 'https://www.pexels.com/license/' });
  expect(result.items[0].tags).toContain('团队');
  expect(request.mock.calls[0][1]?.headers).toEqual({ Authorization: 'test-key' });
});

it('uses the current video endpoint and chooses an HD MP4 without taking the 4K file', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ videos: [{
    id: 7, width: 3840, height: 2160, url: 'https://www.pexels.com/video/7/', image: 'https://images.pexels.com/videos/7.jpg',
    duration: 8, user: { name: 'Author' }, video_files: [
      { file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/7-4k.mp4' },
      { file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/7-hd.mp4' }
    ]
  }] }));
  const result = await pexelsAdapter.search({ query: 'city', type: 'video', page: 1 }, { key: 'key', tier: 'demo' }, request);
  expect(String(request.mock.calls[0][0])).toContain('/v1/videos/search');
  expect(result.items[0].download).toContain('hd.mp4');
});

it('rejects arbitrary media hosts', () => {
  for (const url of ['http://images.pexels.com/a', 'https://127.0.0.1/a', 'https://images.pexels.com.evil.test/a', 'https://user:pass@images.pexels.com/a'])
    expect(pexelsAdapter.mediaUrl(url)).toBeUndefined();
});
