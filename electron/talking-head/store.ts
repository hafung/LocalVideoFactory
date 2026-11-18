import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TalkProjectSchema, type TalkProject } from '../../shared/talking-head.js';

export class TalkProjectStore {
  constructor(readonly root: string) {}
  directory(id: string): string { return path.join(this.root, z.string().uuid().parse(id)); }
  async read(id: string): Promise<TalkProject> {
    return TalkProjectSchema.parse(JSON.parse(await readFile(path.join(this.directory(id), 'project.json'), 'utf8')));
  }
  async save(input: TalkProject): Promise<void> {
    const project = TalkProjectSchema.parse(input);
    const directory = this.directory(project.id);
    const revisions = path.join(directory, 'revisions');
    const currentFile = path.join(directory, 'project.json');
    const json = `${JSON.stringify(project, null, 2)}\n`;
    let current: TalkProject | undefined;
    try { current = await this.read(project.id); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (current?.revision === project.revision && JSON.stringify(current) === JSON.stringify(project)) return;
    if (project.revision !== (current?.revision ?? 0) + 1) throw new Error('口播工程修订号冲突');

    // IPC serializes writes to each project. Only project.json advances the committed
    // revision. If its rename fails, the next save may replace the unfinished revision.
    await mkdir(revisions, { recursive: true });
    const id = randomUUID();
    const temporaryRevision = path.join(revisions, `.${id}.tmp`);
    const temporaryCurrent = path.join(directory, `.project-${id}.tmp`);
    try {
      await writeFile(temporaryRevision, json);
      await writeFile(temporaryCurrent, json);
      await rename(temporaryRevision, path.join(revisions, `${project.revision}.json`));
      await rename(temporaryCurrent, currentFile);
    } finally {
      await Promise.allSettled([temporaryRevision, temporaryCurrent].map(file => rm(file, { force: true })));
    }
  }
}
