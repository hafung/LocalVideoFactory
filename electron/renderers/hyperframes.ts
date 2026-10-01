import type { EditPlan } from '../../shared/edit-plan.js';
import type { VideoRenderer, PreparedComposition, RenderProgressHandler, RenderRequest, RenderResult } from './renderer.js';
import { compileFixedTemplate, type AssetPathResolver } from './template-compiler.js';
import { spawn, execFile } from 'node:child_process';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FfprobeMediaProbe } from '../media/probe.js';
import { mixNarration } from '../media/mix.js';

export interface RendererTools { chromePath: string; ffmpegPath: string; ffprobePath: string }

export class HyperframesPreviewRenderer implements VideoRenderer {
  private readonly jobs = new Map<string, AbortController>();
  constructor(private readonly resolveAsset?: AssetPathResolver, private readonly tools?: RendererTools) {}

  async prepareAudio(plan: EditPlan, workspace: string): Promise<string> {
    if (this.tools && plan.narration.audioPath && plan.narration.durationMs) {
      await mkdir(workspace, { recursive: true });
      const mixed = path.join(workspace, 'mixed.wav');
      const bgm = plan.bgm.enabled && plan.bgm.assetId && this.resolveAsset
        ? { path: await this.resolveAsset(plan.bgm.assetId), volume: plan.bgm.volume, ducking: plan.bgm.ducking } : undefined;
      if (plan.bgm.enabled && plan.bgm.assetId && !bgm) throw new Error('请选择有效的配乐素材');
      let original: { path: string; volume: number; ducking: boolean } | undefined;
      if (plan.audio.originalEnabled) {
        if (!plan.input.sourceVideoPath) throw new Error('工程没有原始视频，无法保留原声');
        const metadata = await new FfprobeMediaProbe(this.tools.ffprobePath).probe(plan.input.sourceVideoPath);
        if (!metadata.hasAudio) throw new Error('原始视频没有音轨，无法保留原声');
        original = { path: plan.input.sourceVideoPath, volume: plan.audio.originalVolume, ducking: plan.audio.originalDucking };
      }
      await mixNarration(this.tools.ffmpegPath, plan.narration.audioPath, mixed, plan.narration.durationMs,
        { narrationVolume: plan.audio.narrationVolume, original, bgm, playbackRate: plan.output.playbackRate });
      return mixed;
    }
    if (plan.bgm.enabled && plan.bgm.assetId || plan.audio.originalEnabled || plan.audio.narrationVolume !== 1 || plan.output.playbackRate !== 1) throw new Error('音轨混音需要 FFmpeg');
    return plan.narration.audioPath!;
  }

  async prepare(plan: EditPlan, workspace: string): Promise<PreparedComposition> {
    const audioPath = await this.prepareAudio(plan, workspace);
    return compileFixedTemplate({ ...plan, narration: { ...plan.narration, audioPath } }, workspace, this.resolveAsset);
  }

  async render(request: RenderRequest, onProgress: RenderProgressHandler): Promise<RenderResult> {
    if (!this.tools) throw new Error('请先安装离线渲染浏览器及 FFmpeg');
    const { chromePath, ffmpegPath, ffprobePath } = this.tools;
    await Promise.all([chromePath, ffmpegPath, ffprobePath].map(file => access(file)));
    if (path.extname(request.outputPath).toLowerCase() !== '.mp4') throw new Error('导出路径必须为 MP4');
    const temporary = path.join(path.dirname(request.outputPath), `.voxweave-${request.jobId}.partial.mp4`);
    const controller = new AbortController();
    this.jobs.set(request.jobId, controller);
    try {
      await new Promise<void>((resolve, reject) => {
        const worker = spawn(process.execPath,
          [fileURLToPath(new URL('./export-worker.js', import.meta.url)), request.composition.workspace, temporary, chromePath], {
            windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HYPERFRAMES_FFMPEG_PATH: ffmpegPath, HYPERFRAMES_FFPROBE_PATH: ffprobePath }
          });
        let failure = ''; let done = false;
        worker.stdout?.on('data', () => undefined);
        worker.stderr?.on('data', chunk => { failure = (failure + String(chunk)).slice(-6000); });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = () => {
          if (worker.connected) worker.send({ cancel: true });
          killTimer = setTimeout(() => {
            if (!worker.pid) return;
            if (process.platform === 'win32') execFile('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
            else { try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
          }, 15000);
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        worker.on('message', (message: { error?: string; done?: boolean; progress?: number; message?: string; status?: string }) => {
          if (message.error) failure = message.error;
          if (message.done) done = true;
          if (message.progress !== undefined) onProgress({ jobId: request.jobId,
            phase: message.status === 'rendering' ? 'capturing' : 'encoding',
            progress: Math.min(.98, Math.max(0, message.progress / 100)),
            message: message.status === 'rendering' ? `正在渲染画面… ${Math.round(message.progress)}%`
              : message.status === 'preprocessing' ? '正在准备画面和声音…' : '正在合成 MP4…' });
        });
        worker.once('error', error => { clearTimeout(killTimer); controller.signal.removeEventListener('abort', abort); reject(error); });
        worker.once('exit', code => {
          clearTimeout(killTimer);
          controller.signal.removeEventListener('abort', abort);
          if (controller.signal.aborted) reject(new Error('导出已取消'));
          else if (code !== 0 || !done) reject(new Error(failure || `渲染进程退出：${code}`));
          else resolve();
        });
      });
      controller.signal.throwIfAborted();
      const metadata = await new FfprobeMediaProbe(ffprobePath).probe(temporary);
      if (metadata.videoCodec !== 'h264' || metadata.audioCodec !== 'aac' || !metadata.durationMs ||
        Math.abs(metadata.durationMs - request.composition.durationMs) > 250) throw new Error('导出文件音视频轨或时长校验失败');
      await rename(temporary, request.outputPath);
      onProgress({ jobId: request.jobId, phase: 'complete', progress: 1, message: 'MP4 已导出' });
      return { outputPath: request.outputPath, durationMs: metadata.durationMs };
    } finally {
      this.jobs.delete(request.jobId);
      await rm(temporary, { force: true });
    }
  }

  async cancel(jobId: string): Promise<void> { this.jobs.get(jobId)?.abort(); }
}
