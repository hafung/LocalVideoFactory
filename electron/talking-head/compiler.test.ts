import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { compileTalkTemplate } from './compiler.js';
import { talkFixture } from './fixtures.test-support.js';

it('compiles an independent layered composition with synchronized source cuts and escaped graphics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'voxweave-talk-compiler-'));
  try {
    await mkdir(path.join(directory, 'media'));
    const source = path.join(directory, 'media', 'source.mp4'), audio = path.join(directory, 'voice.wav'), broll = path.join(directory, 'broll.mp4');
    await Promise.all([writeFile(source, 'source'), writeFile(audio, 'voice'), writeFile(broll, 'broll')]);
    const project = talkFixture({ cuts: [{ id: 'p', startMs: 2000, endMs: 3500, kind: 'pause', applied: true, decided: true, reason: 'pause' }],
      overlays: [{ id: 'graphic', cueId: 'first', type: 'whiteboard', text: '<script>alert(1)</script>', layout: 'pip', position: 'top-left', sourceInMs: 0, enabled: true },
        { id: 'broll', cueId: 'second', type: 'video', assetId: 'broll', text: '', layout: 'cover', position: 'top-right', sourceInMs: 0, enabled: true }] });
    const prepared = await compileTalkTemplate(project, directory, path.join(directory, 'preview'), audio,
      () => ({ filePath: broll, type: 'video', durationMs: 10000 }));
    const html = await readFile(prepared.entryUrl, 'utf8');
    expect(prepared.durationMs).toBe(4500);
    expect(html).toContain('data-composition-id="talk-root"');
    expect(html).not.toContain('voxweave-root');
    expect(html).toContain('data-media-start="3.500"');
    expect(html).toContain('data-start="2.500"');
    expect(html).toContain('data-timeline-role="captions"');
    expect(html).toContain('class="clip" src="./assets/voice.wav"');
    expect(html).toContain('media-overlay cover');
    expect(html).toContain('whiteboard pip top-left');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('class="unrevealed"');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(await readFile(path.join(directory, 'preview', 'assets', 'source.mp4'), 'utf8')).toBe('source');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
