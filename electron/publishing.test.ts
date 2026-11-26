import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { publishCopy } from '../shared/publishing.js';
import { cachedPublishVideo, publishDestination, suggestPublishCopy } from './publishing.js';

describe('publishing', () => {
  it('uses the exact same rendered MP4 for revised copy and renders a new project revision', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'voxweave-publish-'));
    try {
      const render = vi.fn(async (file: string) => { await writeFile(file, 'rendered'); });
      const first = await cachedPublishVideo(directory, ['clip', 1], render);
      expect(await cachedPublishVideo(directory, ['clip', 1], render)).toBe(first);
      expect(await readFile(first, 'utf8')).toBe('rendered');
      expect(await cachedPublishVideo(directory, ['clip', 2], render)).not.toBe(first);
      expect(render).toHaveBeenCalledTimes(2);
      const privateData = path.join(directory, 'private');
      await mkdir(privateData);
      await expect(publishDestination(privateData, privateData)).rejects.toThrow('应用数据目录');
      expect(await publishDestination(directory, privateData)).toBe(await realpath(directory));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('formats editable copy and rejects AI-generated numbers absent from the cited content', async () => {
    const request = { platform: 'general' as const, evidence: '可以导出视频、封面和文案。' };
    const output = { title: '导出发布包', description: '保存视频和封面。', tags: '帧舟 #剪辑 帧舟', quote: request.evidence };
    expect(publishCopy(await suggestPublishCopy(request, async () => output))).toBe('导出发布包\n\n保存视频和封面。\n\n#帧舟 #剪辑');
    await expect(suggestPublishCopy(request, async () => ({ ...output, description: '提升 80% 的效率。' }))).rejects.toThrow('数字与素材不一致');
  });
});
