import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenverseClient, assertMusicUrl, musicLicense } from './openverse.js';

const track = {
  id: '0b2b8bcb-35f4-4a8e-852b-92a50f7c91e8', title: 'Piano Remix', creator: 'Composer',
  foreign_landing_url: 'https://freesound.org/people/composer/sounds/112071/',
  url: 'https://cdn.freesound.org/previews/112/112071-hq.mp3',
  license: 'cc0', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  provider: 'freesound', duration: 110773, filetype: 'mp3', category: null,
  attribution: 'Piano Remix by Composer is marked with CC0 1.0.', tags: [{ name: 'piano' }]
};
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const search = (results: unknown[] = [track], page = 1) => json({ results, page_count: 3, page });

describe('Openverse music', () => {
  it('searches CC0 music without an API key, preserves uncategorized music, caches, and paginates', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(search()).mockResolvedValueOnce(search([track], 2));
    const client = new OpenverseClient(request);
    const result = await client.search({ query: '钢琴' });
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.searchParams.get('q')).toBe('piano music');
    expect(url.searchParams.get('license')).toBe('cc0');
    expect(url.searchParams.has('category')).toBe(false);
    expect(request.mock.calls[0][1]?.headers).toBeUndefined();
    expect(result.items[0]).toMatchObject({ name: 'Piano Remix', durationMs: 110773, author: 'Composer', license: 'cc0' });
    expect(result.items[0].tags).toContain('钢琴');
    await client.search({ query: '钢琴' });
    expect(request).toHaveBeenCalledTimes(1);
    expect((await client.search({ query: '钢琴', page: 2 })).page).toBe(2);
    expect(new URL(String(request.mock.calls[1][0])).searchParams.get('page')).toBe('2');
  });

  it('filters unsafe, contradictory, noncommercial, short, and unsupported results independently', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(search([
      track, { ...track, license: 'by-nc' }, { ...track, license_url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
      { ...track, duration: 1500 }, { ...track, url: 'https://127.0.0.1/audio.mp3' },
      { ...track, url: 'https://cdn.freesound.org/file.exe', filetype: 'exe' }, { ...track, mature: true },
      { ...track, foreign_landing_url: 'https://evil.test/' }, { broken: true }
    ]));
    expect((await new OpenverseClient(request).search({ query: 'piano' })).items).toHaveLength(1);
    for (const url of ['http://cdn.freesound.org/a', 'https://cdn.freesound.org.evil.test/a', 'https://cdn.freesound.org:8080/a',
      'https://user:pass@cdn.freesound.org/a', 'file:///tmp/a', 'https://localhost/a']) expect(() => assertMusicUrl(url)).toThrow();
  });

  it('includes CC BY only when requested and retains credit and license metadata', async () => {
    const by = { ...track, license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', attribution: 'Required credit' };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => search([track, by]));
    const client = new OpenverseClient(request);
    expect((await client.search({ query: 'piano' })).items).toHaveLength(1);
    const result = await client.search({ query: 'piano', license: 'cc0-by' });
    expect(result.items).toHaveLength(2);
    expect(new URL(String(request.mock.calls[1][0])).searchParams.get('license')).toBe('cc0,by');
    expect(musicLicense(result.items[1])).toMatchObject({ source: 'openverse', status: 'licensed', author: 'Composer', sourceUrl: track.foreign_landing_url,
      licenseUrl: by.license_url, note: expect.stringContaining('Required credit') });
  });

  it('rechecks the license and streams audio to disk through validated redirects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'voxweave-music-'));
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(search()).mockResolvedValueOnce(json(track))
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/audio.mp3' } }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }));
      const client = new OpenverseClient(request);
      await client.search({ query: 'piano' });
      const result = await client.download(track.id, directory);
      expect([...await readFile(result.filePath)]).toEqual([1, 2, 3]);
      expect(result.filePath).toMatch(/\.mp3$/u);
      expect(String(request.mock.calls[1][0])).toContain(`${track.id}/`);
      expect(request.mock.calls[2][1]?.redirect).toBe('manual');
      expect(request.mock.calls[3][0]).toBe('https://cdn.freesound.org/audio.mp3');
      expect(await readdir(directory)).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['license', 'redirect', 'size', 'html', 'empty', 'stream'])('rejects a bad %s download and removes partial files', async reason => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'voxweave-music-'));
    try {
      const request = vi.fn<typeof fetch>().mockResolvedValueOnce(search()).mockResolvedValueOnce(json(reason === 'license' ? { ...track, license: 'by-nc' } : track));
      if (reason === 'redirect') request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/a' } }));
      if (reason === 'size') request.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(101 * 1024 * 1024) } }));
      if (reason === 'html') request.mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
      if (reason === 'empty') request.mockResolvedValueOnce(new Response(new Uint8Array()));
      if (reason === 'stream') request.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); },
        pull(controller) { controller.error(new Error('Connection lost')); } }), { headers: { 'content-type': 'audio/mpeg' } }));
      const client = new OpenverseClient(request);
      await client.search({ query: 'piano' });
      await expect(client.download(track.id, directory)).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('requires a fresh search when the CC BY version changes before download', async () => {
    const by = { ...track, license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/' };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(search([by]))
      .mockResolvedValueOnce(json({ ...by, license_version: '3.0', license_url: 'https://creativecommons.org/licenses/by/3.0/' }));
    const client = new OpenverseClient(request);
    await client.search({ query: 'piano', license: 'cc0-by' });
    await expect(client.download(track.id, '/tmp')).rejects.toThrow('许可已变更');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports quotas and network errors and refuses unsearched downloads', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429 })).mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = new OpenverseClient(request);
    await expect(client.search({ query: 'piano' })).rejects.toThrow('稍后');
    await expect(client.search({ query: 'piano' })).rejects.toThrow('检查网络');
    await expect(client.download(track.id, '/tmp')).rejects.toThrow('过期');
  });
});
