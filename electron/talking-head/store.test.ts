import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { TalkProjectStore } from './store.js';
import { talkFixture } from './fixtures.test-support.js';
import { updateTalkProject } from './editing.js';

it('saves isolated revisions and rejects conflicting writes or path traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-talk-store-'));
  try {
    const store = new TalkProjectStore(root), project = talkFixture();
    await store.save(project);
    await store.save(project);
    const corrected = updateTalkProject(project, { revision: 1, edits: [{ cueId: 'first', text: '改过的字幕' }] });
    // The process may have stopped after writing the revision but before publishing it.
    await writeFile(path.join(root, project.id, 'revisions', '2.json'), '{"interrupted":true}');
    await store.save(corrected);
    expect((await store.read(project.id)).cues[0].text).toBe('改过的字幕');
    expect(JSON.parse(await readFile(path.join(root, project.id, 'revisions', '1.json'), 'utf8')).cues[0].text).toBe('声织很好。');
    await expect(store.save({ ...corrected, cues: project.cues })).rejects.toThrow('修订号冲突');
    await expect(store.save(project)).rejects.toThrow('修订号冲突');
    expect(() => store.directory('../projects')).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
