import { app, dialog, ipcMain, type WebContents } from 'electron';
import Store from 'electron-store';
import { randomUUID } from 'node:crypto';
import { access, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TalkCreateSchema, TalkProjectSchema, TalkUpdateSchema, TalkVoiceAuditionSchema, TalkHighlightEditSchema,
  talkCanvas, type TalkProject, type TalkResult,
  type TalkProgress, type TalkExportProgress } from '../../shared/talking-head.js';
import { PublishDraftSchema } from '../../shared/publishing.js';
import { TalkProjectStore } from './store.js';
import { talkCues, pauseCuts, fillerSuggestions, updateTalkProject } from './editing.js';
import { importTalkVideo, analyzeTalkVideo, prepareTalkAudio, prepareTalkVoiceAudition, talkMediaStatus, type TalkMediaTools } from './media.js';
import { compileTalkTemplate } from './compiler.js';
import { resolveTalkAssets } from './assets.js';
import { talkSrt, talkAss } from './captions.js';
import { editTalkHighlight, findTalkHighlights, highlightProject } from './highlights.js';
import { LocalLlamaScenePlanner } from '../composition/scene-planner.js';
import { cachedPublishVideo, publishDestination, writePublishBundle } from '../publishing.js';
import { HyperframesPreviewRenderer, type RendererTools } from '../renderers/hyperframes.js';
import type { PreviewRegistry } from '../renderers/preview-registry.js';
import type { MediaAsset } from '../../shared/library.js';

interface Dependencies {
  userData: string;
  mediaTools: () => TalkMediaTools | undefined;
  rendererTools: () => RendererTools | undefined;
  sceneModelPaths: () => { enginePath?: string; modelPath?: string };
  previews: PreviewRegistry;
  library: { byId(id: string): MediaAsset | undefined; list(limit?: number): MediaAsset[] };
  allowOutput(file: string): void;
}
const idSchema = z.string().uuid();
const revisionSchema = z.number().int().positive();
const exportOptions = z.object({ revision: revisionSchema, highlightId: idSchema.optional(), draft: PublishDraftSchema.optional() }).strict().optional();
const sameFile = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function registerTalkingHead(deps: Dependencies) {
  const store = new TalkProjectStore(path.join(deps.userData, 'talking-head-projects'));
  const settings = new Store<{ lastProjectId?: string }>({ name: 'talking-head-settings', defaults: {} });
  const jobs = new Map<string, AbortController>();
  const locks = new Set<string>();
  const exports = new Map<string, { controller: AbortController; renderer: HyperframesPreviewRenderer }>();
  const operations = new Set<AbortController>();
  const highlightJobs = new Map<string, AbortController>();
  const lastPreview = new Map<string, string>();
  const tools = () => {
    const value = deps.mediaTools();
    if (!value) throw new Error('口播精剪需要 FFmpeg 和 ffprobe');
    return value;
  };
  async function prepare(project: TalkProject, signal: AbortSignal, save?: () => Promise<void>): Promise<TalkResult> {
    signal.throwIfAborted();
    const directory = store.directory(project.id), attempt = randomUUID();
    const previewRoot = path.join(directory, 'preview'), folder = `r${project.revision}-${attempt}`;
    const workspace = path.join(previewRoot, folder);
    const rendering = await resolveTalkAssets(project, id => deps.library.byId(id));
    let prepared;
    try {
      const audio = await prepareTalkAudio(rendering.project, directory, tools(), id => rendering.resolve(id).filePath, signal);
      signal.throwIfAborted();
      prepared = await compileTalkTemplate(rendering.project, directory, workspace, audio, rendering.resolve);
      signal.throwIfAborted();
      await save?.();
    } catch (error) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const previewId = `talk-${project.id}-${project.revision}-${attempt}`;
    const entryUrl = deps.previews.register(previewId, workspace);
    // Keep the previous workspace until the renderer has switched to this one.
    const previous = lastPreview.get(project.id);
    lastPreview.set(project.id, folder);
    const folders = await readdir(previewRoot, { withFileTypes: true }).catch(() => []);
    await Promise.allSettled(folders.filter(entry => entry.isDirectory() && /^r\d+-[\da-f-]{36}$/u.test(entry.name) &&
      entry.name !== folder && entry.name !== previous).map(entry => {
      deps.previews.unregister(`talk-${project.id}-${entry.name.slice(1)}`);
      return rm(path.join(previewRoot, entry.name), { recursive: true, force: true });
    }));
    return { project, preview: { entryUrl, sourceUrl: entryUrl.replace(/index\.html$/u, 'assets/source.mp4'),
      durationMs: prepared.durationMs, ...talkCanvas(project), warnings: rendering.warnings } };
  }
  async function withProject<T>(id: string, revision: number, run: (project: TalkProject) => Promise<T>): Promise<T> {
    if (locks.has(id)) throw new Error('口播工程正在处理，请稍后再试');
    locks.add(id);
    try {
      const project = await store.read(id);
      if (revision !== project.revision) throw new Error('口播工程已更新，请重新操作');
      return await run(project);
    } finally { locks.delete(id); }
  }
  function send(sender: WebContents, channel: string, value: TalkProgress | TalkExportProgress) {
    if (!sender.isDestroyed()) sender.send(channel, value);
  }
  ipcMain.handle('talk:status', () => talkMediaStatus(deps.mediaTools()));
  ipcMain.handle('talk:create', async (event, value: unknown) => {
    const request = TalkCreateSchema.parse(value);
    if (jobs.size) throw new Error('请等待当前口播处理完成，或先取消');
    const ready = await talkMediaStatus(deps.mediaTools());
    if (!ready.ready) throw new Error(ready.message);
    // Recheck after async resource validation: two concurrent requests must not both start.
    if (jobs.size) throw new Error('已有口播正在处理');
    const jobId = randomUUID(), projectId = randomUUID(), controller = new AbortController();
    let saved = false;
    jobs.set(jobId, controller);
    const emit = (phase: TalkProgress['phase'], progress: number, message: string, result?: TalkResult) =>
      send(event.sender, 'talk:progress', { jobId, phase, progress, message, result });
    void (async () => {
      emit('importing', .02, '正在保存原片并准备可精确定位的工作视频…');
      const directory = store.directory(projectId), mediaTools = tools();
      const source = await importTalkVideo(request.sourcePath, directory, mediaTools, controller.signal);
      emit('recognizing', .2, '正在识别原始口播…');
      const analysis = await analyzeTalkVideo(directory, source.durationMs, mediaTools, controller.signal,
        (fraction, message) => emit('recognizing', .2 + fraction * .55, message));
      const cues = talkCues(analysis.tokens);
      if (!cues.length) throw new Error('没有识别到可用口播，请检查音轨、音量和视频内容');
      const now = new Date().toISOString();
      let project = TalkProjectSchema.parse({ schemaVersion: 1, mode: 'talking-head', id: projectId, revision: 1,
        createdAt: now, updatedAt: now, source, strength: request.strength,
        captions: { enabled: true, reveal: 'phrase', highlight: 'color', position: 'bottom' },
        cues, cuts: [], speech: analysis.speech, silence: analysis.silence, overlays: [],
        audio: { voiceVolume: 1, bgmVolume: .12, ducking: true },
        warnings: ['识别可能遗漏犹豫音、结巴或半截字；口头语建议需试听确认，可手动指定剪辑区间。',
          '逐字时间含估计值，用于字幕展示；自动停顿剪辑另用语音边界与静音复核。'] });
      emit('editing', .8, '正在缩短有静音证据的长停顿，保留可恢复记录…');
      project = TalkProjectSchema.parse({ ...project, cuts: [...pauseCuts(project), ...fillerSuggestions(analysis.tokens, source.durationMs)] });
      emit('preparing', .86, '正在同步原声、画面和字幕…');
      const result = await prepare(project, controller.signal, async () => {
        await store.save(project);
        saved = true;
        settings.set('lastProjectId', project.id);
      });
      emit('complete', 1, '口播精剪预览已就绪', result);
    })().catch(async error => {
      const cancelled = controller.signal.aborted;
      if (!saved) {
        try { await rm(store.directory(projectId), { recursive: true, force: true }); }
        catch { /* A failed temporary import must not hide the original error. */ }
      }
      // A failed import never replaces the last successful project.
      emit(cancelled ? 'cancelled' : 'error', 0, cancelled ? '处理已取消，原有口播工程仍保留' : error instanceof Error ? error.message : String(error));
    }).finally(() => jobs.delete(jobId));
    return { jobId };
  });
  ipcMain.handle('talk:cancel', (_event, value: unknown) => jobs.get(idSchema.parse(value))?.abort());
  ipcMain.handle('talk:resume', async () => {
    const id = settings.get('lastProjectId');
    if (!id) return null;
    if (locks.has(id)) throw new Error('口播工程正在更新，请稍后重试');
    locks.add(id);
    const controller = new AbortController(); operations.add(controller);
    try { return await prepare(await store.read(id), controller.signal); }
    finally { locks.delete(id); operations.delete(controller); }
  });
  ipcMain.handle('talk:update', async (_event, idValue: unknown, value: unknown) => {
    const id = idSchema.parse(idValue), change = TalkUpdateSchema.parse(value);
    if (locks.has(id)) throw new Error('口播工程正在处理，请稍后再试');
    locks.add(id);
    const controller = new AbortController(); operations.add(controller);
    try {
      const project = updateTalkProject(await store.read(id), change);
      return await prepare(project, controller.signal, () => store.save(project));
    } finally { locks.delete(id); operations.delete(controller); }
  });
  ipcMain.handle('talk:audition-voice', async (_event, idValue: unknown, value: unknown) => {
    const id = idSchema.parse(idValue), request = TalkVoiceAuditionSchema.parse(value);
    const controller = new AbortController(); operations.add(controller);
    try {
      const project = await store.read(id);
      if (request.revision !== project.revision) throw new Error('口播工程已更新，请重新试听');
      return await prepareTalkVoiceAudition(project, store.directory(id), tools().ffmpegPath, request, controller.signal);
    } finally { operations.delete(controller); }
  });
  ipcMain.handle('talk:highlights', (_event, id: unknown) => store.readHighlights(idSchema.parse(id)));
  ipcMain.handle('talk:find-highlights', async (_event, idValue: unknown, value: unknown) => {
    const id = idSchema.parse(idValue), input = z.object({ revision: revisionSchema, goal: z.string().trim().max(240) }).strict().parse(value);
    const paths = deps.sceneModelPaths();
    if (!paths.modelPath || !paths.enginePath) throw new Error('请在创作设置中启用本地分镜模型，或手动添加片段');
    return withProject(id, input.revision, async project => {
      const controller = new AbortController();
      const model = new LocalLlamaScenePlanner(() => paths);
      highlightJobs.set(id, controller); operations.add(controller);
      try {
        const items = await findTalkHighlights(project, input.goal, (prompt, data, signal) => model.json(prompt, data, signal, undefined, 1200), controller.signal);
        const saved = (await store.readHighlights(id)).items.filter(item => item.confirmed);
        const proposed = items.filter(item => !saved.some(clip => Math.min(clip.endMs, item.endMs) - Math.max(clip.startMs, item.startMs) >=
          Math.min(clip.endMs - clip.startMs, item.endMs - item.startMs) * .6));
        controller.signal.throwIfAborted();
        return await store.saveHighlights(id, { version: 1, goal: input.goal, items: [...saved, ...proposed].slice(0, 30) });
      } catch (error) {
        if (controller.signal.aborted) throw new Error('已取消精彩片段分析');
        throw error;
      } finally { model.dispose(); highlightJobs.delete(id); operations.delete(controller); }
    });
  });
  ipcMain.handle('talk:cancel-highlights', (_event, id: unknown) => highlightJobs.get(idSchema.parse(id))?.abort());
  ipcMain.handle('talk:save-highlight', (_event, idValue: unknown, revision: unknown, value: unknown) => {
    const id = idSchema.parse(idValue), edit = TalkHighlightEditSchema.parse(value);
    return withProject(id, revisionSchema.parse(revision), async project => {
      const state = await store.readHighlights(id);
      const current = edit.id ? state.items.find(item => item.id === edit.id) : undefined;
      if (edit.id && !current) throw new Error('精彩片段已移除');
      if (!current && state.items.length >= 30) throw new Error('每个工程最多保存 30 条精彩片段');
      const next = editTalkHighlight(project, current, edit);
      const items = current ? state.items.map(item => item.id === next.id ? next : item) : [...state.items, next];
      return store.saveHighlights(id, { ...state, items });
    });
  });
  ipcMain.handle('talk:remove-highlight', (_event, idValue: unknown, revision: unknown, highlightValue: unknown) => {
    const id = idSchema.parse(idValue), highlightId = idSchema.parse(highlightValue);
    return withProject(id, revisionSchema.parse(revision), async () => {
      const state = await store.readHighlights(id);
      return store.saveHighlights(id, { ...state, items: state.items.filter(item => item.id !== highlightId) });
    });
  });
  ipcMain.handle('talk:export', async (event, idValue: unknown, kindValue: unknown, optionsValue: unknown) => {
    const id = idSchema.parse(idValue), kind = z.enum(['mp4', 'srt', 'ass', 'publish']).parse(kindValue);
    const options = exportOptions.parse(optionsValue), draft = options?.draft;
    if ((kind === 'publish') !== Boolean(draft)) throw new Error('请选择有效的发布包设置');
    if (locks.has(id) || exports.size) throw new Error('口播工程已有导出或更新任务');
    locks.add(id);
    try {
      const original = await store.read(id);
      if (options && options.revision !== original.revision) throw new Error('口播工程已更新，请重新导出');
      const highlights = options?.highlightId ? await store.readHighlights(id) : undefined;
      const clip = highlights?.items.find(item => item.id === options?.highlightId);
      if (options?.highlightId && !clip) throw new Error('精彩片段已移除');
      const project = clip ? highlightProject(original, clip) : original;
      let destination: string;
      if (draft) {
        const result = await dialog.showOpenDialog({ title: '选择发布包保存位置', properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || !result.filePaths[0]) { locks.delete(id); return null; }
        destination = await publishDestination(result.filePaths[0], deps.userData);
      } else {
        const result = await dialog.showSaveDialog({ title: `导出口播 ${kind.toUpperCase()}`,
          defaultPath: `${clip ? '口播片段' : '口播精剪'}.${kind}`, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] });
        if (result.canceled || !result.filePath) { locks.delete(id); return null; }
        destination = result.filePath;
        if (path.extname(destination).toLowerCase() !== `.${kind}`) throw new Error(`请使用 .${kind} 扩展名`);
        const relative = path.relative(store.root, path.resolve(destination));
        if ((!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ||
          sameFile(destination, original.source.originalPath) || deps.library.list(10000).some(asset => sameFile(destination, asset.filePath))) {
          throw new Error('导出路径不能覆盖原片、素材或工程文件');
        }
      }
      if (clip && highlights && !clip.confirmed) {
        await store.saveHighlights(id, { ...highlights, items: highlights.items.map(item => item.id === clip.id ? { ...item, confirmed: true } : item) });
      }
      const jobId = randomUUID(), controller = new AbortController();
      const renderTools = deps.rendererTools(), renderer = new HyperframesPreviewRenderer(undefined, renderTools);
      exports.set(jobId, { controller, renderer });
      const emit = (value: Omit<TalkExportProgress, 'jobId'>) => send(event.sender, 'talk:export-progress', { ...value, jobId });
      const directory = store.directory(id), workspace = path.join(directory, 'exports', jobId);
      void (async () => {
        let warnings: string[] = [], outputPath = destination;
        emit({ phase: 'preparing', progress: 0, message: '正在准备口播导出…' });
        if (kind === 'mp4' || draft) {
          if (!renderTools) throw new Error('导出 MP4 需要离线渲染浏览器及 FFmpeg');
          await access(renderTools.chromePath);
          const render = async (file: string) => {
            const rendering = await resolveTalkAssets(project, assetId => deps.library.byId(assetId));
            warnings = rendering.warnings;
            const audio = await prepareTalkAudio(rendering.project, directory, tools(), assetId => rendering.resolve(assetId).filePath, controller.signal);
            const composition = await compileTalkTemplate(rendering.project, directory, workspace, audio, rendering.resolve);
            controller.signal.throwIfAborted();
            const cancellation = setInterval(() => { if (controller.signal.aborted) void renderer.cancel(jobId); }, 50);
            try {
              await renderer.render({ jobId, composition, outputPath: file }, progress => {
                if (progress.phase !== 'complete') emit(progress);
              });
            } finally { clearInterval(cancellation); }
          };
          if (draft) {
            const video = await cachedPublishVideo(path.join(directory, 'publish-video'),
              [original.revision, clip?.startMs, clip?.endMs], render);
            emit({ phase: 'encoding', progress: .98, message: '正在制作封面并打包…' });
            const bundle = await writePublishBundle(destination, video, draft, renderTools, controller.signal);
            outputPath = bundle.outputPath;
            warnings = [bundle.summary, ...warnings];
          } else await render(outputPath);
        } else {
          const subtitle = path.join(path.dirname(outputPath), `.talk-${jobId}.${kind}`);
          try {
            await writeFile(subtitle, kind === 'srt' ? talkSrt(project) : talkAss(project));
            controller.signal.throwIfAborted();
            await rename(subtitle, outputPath);
          } finally { await rm(subtitle, { force: true }); }
        }
        deps.allowOutput(outputPath);
        emit({ phase: 'complete', progress: 1, message: [draft ? '发布包已导出' : `${kind.toUpperCase()} 已导出`, ...warnings].join('。'), outputPath });
      })().catch(error => emit({ phase: controller.signal.aborted ? 'cancelled' : 'error', progress: 0,
        message: controller.signal.aborted ? '口播导出已取消' : error instanceof Error ? error.message : String(error) }))
        .finally(async () => {
          await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
          exports.delete(jobId); locks.delete(id);
        });
      return { jobId };
    } catch (error) { locks.delete(id); throw error; }
  });
  ipcMain.handle('talk:cancel-export', (_event, value: unknown) => {
    const id = idSchema.parse(value), job = exports.get(id); job?.controller.abort(); void job?.renderer.cancel(id);
  });
  let quitting = false;
  app.on('before-quit', event => {
    if (!jobs.size && !exports.size && !operations.size) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const controller of [...jobs.values(), ...operations]) controller.abort();
    for (const [id, job] of exports) { job.controller.abort(); void job.renderer.cancel(id); }
    const timer = setInterval(() => {
      if (!jobs.size && !exports.size && !operations.size) { clearInterval(timer); app.quit(); }
    }, 100);
  });
}
