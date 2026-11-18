import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { streamTalkSource } from './source-stream.js';

it('serves precise byte ranges so Chromium can seek through original footage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voxweave-talk-stream-'));
  try {
    const file = path.join(dir, 'source.mp4');
    await writeFile(file, '0123456789');
    const response = await streamTalkSource(pathToFileURL(file),
      new Request('https://local.test/source.mp4', { headers: { Range: 'bytes=4-7' } }));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-7/10');
    expect(response.headers.get('content-length')).toBe('4');
    expect(await response.text()).toBe('4567');
    const invalid = await streamTalkSource(pathToFileURL(file),
      new Request('https://local.test/source.mp4', { headers: { Range: 'bytes=10-' } }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */10');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
