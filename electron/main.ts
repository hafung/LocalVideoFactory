import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, safeStorage, type WebContents } from 'electron';
import Store from 'electron-store';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportAss, exportSrt } from './composition/subtitle-export.js';
import { QwenEngine, type EngineConfig } from './engine.js';
import { planDraft } from './composition/planner.js';
import { EditPlanStore } from './composition/project-store.js';
import { NarrationService } from './composition/narration.js';
import { QwenNarrationSynthesizer } from './composition/qwen-narration.js';
import { resolveEditPlan } from './composition/resolver.js';
import { FallbackMediaProbe, FfprobeMediaProbe } from './media/probe.js';
import { HyperframesPreviewRenderer } from './renderers/hyperframes.js';
import { PreviewRegistry } from './renderers/preview-registry.js';
import { LibraryDatabase } from './library/database.js';
import { AssetImporter, FfmpegThumbnailer } from './library/importer.js';
import { NoReplacementAssetError, applySceneChoice, replaceSceneAsset } from './library/replace-scene.js';
import { listSceneCandidates } from './library/scene-candidates.js';
import { LocalLlamaEmbedder, SemanticReranker } from './library/semantic.js';
import { selectBroll } from './library/selector.js';
import { alignNarration, senseVoiceNarrationTranscriber } from './alignment/narration.js';
import { CLONE_TTS_MODEL, DEFAULT_TTS_MODEL, TTS_SETUP_VERSION, describeTtsModel, narrationModelPath, resetTtsDevelopmentData } from './tts-model.js';
import { AUTOMATIC_NARRATION_INSTRUCTION } from '../shared/prosody.js';
import { DraftPlanRequestSchema, EditPlanSchema, type EditPlan } from '../shared/edit-plan.js';
import { ImportAssetRequestSchema, UpdateTagsSchema, SearchAssetsRequestSchema, type ImportReport } from '../shared/library.js';
import { searchAssets } from './library/search.js';
import { automaticTags, cleanAutomaticTags } from './library/tags.js';
import { PexelsClient, assertPexelsUrl } from './library/pexels.js';
import { LANGUAGES, type AudioFormat, type CompositionProgressEvent, type GenerateCompositionRequest, type SynthesisRequest, type VoiceProfile } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(devServerUrl);
if (process.env.VOXWEAVE_COMPOSITION_SMOKE_RESULT && process.env.VOXWEAVE_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.VOXWEAVE_TEST_USER_DATA));
}

interface Settings extends EngineConfig {
  lastProjectId?: string; pexelsKeyEncrypted?: string; voiceProfiles?: VoiceProfile[];
  semanticEnginePath?: string; semanticModelPath?: string; semanticEnabled?: boolean;
  ttsSetupVersion?: string;
}
const settings = new Store<Settings>({ name: 'settings', defaults: {} });
const audioJobs = new Map<string, QwenEngine>();
const compositionJobs = new Map<string, { controller: AbortController; engine: QwenEngine }>();
const previews = new PreviewRegistry();
const allowedShellPaths = new Set<string>();
const projectLocks = new Set<string>();
const exportJobs = new Map<string, { renderer: HyperframesPreviewRenderer; cancelled: boolean }>();
let waitingToQuit = false;
app.on('before-quit', event => {
  if (!exportJobs.size) return;
  event.preventDefault();
  if (waitingToQuit) return;
  waitingToQuit = true;
  for (const [id, job] of exportJobs) { job.cancelled = true; void job.renderer.cancel(id); }
  const timer = setInterval(() => {
    if (!exportJobs.size) { clearInterval(timer); app.quit(); }
  }, 100);
});

protocol.registerSchemesAsPrivileged([{
  scheme: 'voxweave-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}, { scheme: 'voxweave-library', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const GenerateCompositionRequestSchema = DraftPlanRequestSchema.extend({
  language: z.enum(LANGUAGES).optional(),
  temperature: z.number().min(0.1).max(1.2).optional(),
  precision: z.enum(['bf16', 'int8', 'int4']).optional(),
  bgm: EditPlanSchema.shape.bgm.optional(),
  audio: EditPlanSchema.shape.audio.optional(),
  playbackRate: z.number().min(.25).max(4).optional()
}).strict();

function resourceRoot(): string {
  return process.env.VOXWEAVE_RESOURCE_ROOT
    ? path.resolve(process.env.VOXWEAVE_RESOURCE_ROOT)
    : app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', 'resources');
}

function configuredPaths() {
  const root = resourceRoot();
  const bundledFfmpeg = path.join(root, 'ffmpeg', 'ffmpeg.exe');
  const bundledFfprobe = path.join(root, 'ffmpeg', 'ffprobe.exe');
  return {
    enginePath: process.env.VOXWEAVE_ENGINE ?? settings.get('enginePath') ?? path.join(root, 'engine', 'qwen_tts.exe'),
    modelDir: narrationModelPath(root, settings.get('modelDir'), process.env.VOXWEAVE_MODEL),
    ffmpegPath: existsSync(bundledFfmpeg) ? bundledFfmpeg : process.env.VOXWEAVE_FFMPEG,
    ffprobePath: existsSync(bundledFfprobe) ? bundledFfprobe : process.env.VOXWEAVE_FFPROBE
  };
}

function semanticPaths(): { enginePath?: string; modelPath?: string } {
  if (settings.get('semanticEnabled') === false) return {};
  const root = path.join(resourceRoot(), 'semantic');
  const enginePath = settings.get('semanticEnginePath') || path.join(root, 'runtime', 'llama-server.exe');
  const modelPath = settings.get('semanticModelPath') || path.join(root, 'model', 'Qwen3-Embedding-0.6B-Q8_0.gguf');
  return existsSync(enginePath) && existsSync(modelPath) ? { enginePath, modelPath } : {};
}

function configuredEngine(overrideModelDir?: string): QwenEngine {
  const { enginePath, modelDir, ffmpegPath } = configuredPaths();
  return new QwenEngine({ enginePath, modelDir: overrideModelDir ?? modelDir, ffmpegPath });
}

function rendererTools() {
  const paths = configuredPaths();
  return paths.ffmpegPath && paths.ffprobePath ? {
    ffmpegPath: paths.ffmpegPath, ffprobePath: paths.ffprobePath,
    chromePath: process.env.VOXWEAVE_CHROME ?? path.join(resourceRoot(), 'browser', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  } : undefined;
}

function sendComposition(sender: WebContents, event: CompositionProgressEvent): void {
  if (!sender.isDestroyed()) sender.send('composition:progress', event);
}

async function runCompositionSmoke(window: BrowserWindow, resultPath: string): Promise<void> {
  let voiceId = 'vivian';
  let clonedVoice: VoiceProfile | undefined;
  if (process.env.VOXWEAVE_COMPOSITION_SMOKE_CLONE_REFERENCE) {
    clonedVoice = await window.webContents.executeJavaScript(`window.voxweave.cloneVoice(${JSON.stringify({
      name: '1.7B clone smoke', referenceAudioPath: process.env.VOXWEAVE_COMPOSITION_SMOKE_CLONE_REFERENCE
    })})`, true) as VoiceProfile;
    voiceId = clonedVoice.id;
  }
  const request = JSON.stringify({
    script: process.env.VOXWEAVE_COMPOSITION_SMOKE_SCRIPT ?? '你好。', voiceId, aspectRatio: '9:16', captionStyle: 'commerce-bold',
    language: 'Chinese', precision: 'int8', playbackRate: Number(process.env.VOXWEAVE_COMPOSITION_SMOKE_RATE ?? 1)
  });
  const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('composition/player smoke timed out')), 120000);
    let stopped = false;
    const finish = (callback, value) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timeout);
      unsubscribe();
      callback(value);
    };
    const waitForPlayer = (event) => {
      const started = Date.now();
      const poll = () => {
        const error = document.querySelector('.preview-error')?.textContent?.trim();
        if (error) return finish(reject, new Error(error));
        const player = document.querySelector('hyperframes-player');
        if (player?.ready && player.getAttribute('src') === event.preview.entryUrl) {
          const observedDuration = player.duration;
          player.muted = true;
          player.seek(Math.min(0.25, observedDuration / 2));
          player.play();
          setTimeout(() => {
            player.pause();
            const settleStarted = Date.now();
            const settle = () => {
              const currentPlayer = document.querySelector('hyperframes-player');
              if ((!currentPlayer?.ready || !currentPlayer.isConnected) && Date.now() - settleStarted < 5000) return setTimeout(settle, 100);
              if (!currentPlayer) return finish(reject, new Error('HyperFrames Player was removed during playback'));
              currentPlayer.seek(Math.min(0.25, observedDuration / 2));
              setTimeout(() => finish(resolve, {
                projectId: event.plan?.id,
                revision: event.plan?.revision,
                status: event.plan?.status,
                captionText: event.plan?.captions?.map(cue => cue.text).join(''),
                captionTokens: event.plan?.captions?.flatMap(cue => cue.tokens).length ?? 0,
                alignedTokens: event.plan?.captions?.flatMap(cue => cue.tokens).filter(token => token.source === 'aligned').length ?? 0,
                previewUrl: event.preview?.entryUrl,
                durationMs: event.preview?.durationMs,
                playerReadyObserved: true,
                playerReadyAfterPlayback: currentPlayer.ready,
                playerDurationSeconds: observedDuration,
                playerCurrentTimeSeconds: currentPlayer.currentTime,
                playerScenes: currentPlayer.scenes?.length ?? 0,
                playerWasReplaced: currentPlayer !== player,
                playerBounds: (() => { const rect = currentPlayer.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()
              }), 250);
            };
            settle();
          }, 350);
          return;
        }
        if (Date.now() - started > 20000) return finish(reject, new Error('HyperFrames Player did not become ready'));
        setTimeout(poll, 100);
      };
      poll();
    };
    const unsubscribe = window.voxweave.onCompositionProgress(event => {
      if (event.phase === 'error' || event.phase === 'cancelled') finish(reject, new Error(event.message));
      else if (event.phase === 'complete' && event.preview) waitForPlayer(event);
    });
    window.voxweave.generateComposition(${request}).catch(error => finish(reject, error));
  })`, true) as Record<string, unknown>;
  const previewFrames = await Promise.all(window.webContents.mainFrame.framesInSubtree
    .filter(frame => frame !== window.webContents.mainFrame)
    .map(async frame => ({
      url: frame.url,
      state: await frame.executeJavaScript(`({
        readyState: document.readyState,
        timelineKeys: Object.keys(window.__timelines || {}),
        timelines: Object.fromEntries(Object.entries(window.__timelines || {}).map(([key, timeline]) => [key, {duration: timeline.duration(), time: timeline.time(), paused: timeline.paused()}])),
        timedElements: [...document.querySelectorAll('[data-animate-start]')].map(element => ({id: element.id, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity})),
        compositions: [...document.querySelectorAll('[data-composition-id]')].map(element => ({id: element.id, compositionId: element.dataset.compositionId, visibility: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity}))
      })`, true)
    })));
  const screenshotPath = process.env.VOXWEAVE_COMPOSITION_SMOKE_SCREENSHOT ?? `${resultPath}.png`;
  await new Promise(resolve => setTimeout(resolve, 250));
  const playerBounds = result.playerBounds as { x: number; y: number; width: number; height: number };
  const previewScreenshot = await window.webContents.capturePage({
    x: Math.floor(playerBounds.x), y: Math.floor(playerBounds.y),
    width: Math.max(1, Math.floor(playerBounds.width)), height: Math.max(1, Math.floor(playerBounds.height * 0.85))
  });
  const previewBitmap = previewScreenshot.toBitmap();
  const previewPixels = previewBitmap.length / 4;
  let nonDarkPixels = 0;
  for (let index = 0; index < previewBitmap.length; index += 4) {
    if (previewBitmap[index] > 110 || previewBitmap[index + 1] > 110 || previewBitmap[index + 2] > 110) nonDarkPixels += 1;
  }
  const previewNonDarkPixelRatio = previewPixels ? nonDarkPixels / previewPixels : 0;
  const screenshot = await window.webContents.capturePage();
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await writeFile(screenshotPath, screenshot.toPNG());
  const libraryManagerVerified = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('.library-button')?.click();
    const start = Date.now();
    const poll = () => {
      const panel = document.querySelector('.library-panel');
      if (panel && panel.textContent.includes('批量导入') && panel.textContent.includes('Pexels')) {
        document.querySelector('[role="dialog"] button[aria-label="关闭"]')?.click(); resolve(true); return;
      }
      if (Date.now() - start > 5000) { reject(new Error('Library manager was not opened')); return; }
      setTimeout(poll, 50);
    }; poll();
  })`, true);
  let artifactResults: unknown;
  if (process.env.VOXWEAVE_ARTIFACT_SMOKE_DIR) {
    artifactResults = await window.webContents.executeJavaScript(`(async () => {
      const outputs = [];
      for (const kind of ['narration-mp3', 'mixed-mp3', 'srt', 'ass']) outputs.push({ kind, ...await window.voxweave.exportArtifact(${JSON.stringify(result.projectId)}, kind) });
      return outputs;
    })()`, true);
  }
  let exportResult: unknown;
  if (process.env.VOXWEAVE_EXPORT_SMOKE_OUTPUT) {
    exportResult = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('MP4 export smoke timed out')); }, 180000);
      const unsubscribe = window.voxweave.onExportProgress(event => {
        if (event.phase === 'complete' || event.phase === 'error' || event.phase === 'cancelled') {
          clearTimeout(timer); unsubscribe();
          if (event.phase === 'complete') resolve(event); else reject(new Error(event.message));
        }
      });
      window.voxweave.exportVideo(${JSON.stringify(result.projectId)}).catch(error => { clearTimeout(timer); unsubscribe(); reject(error); });
    })`, true);
  }
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify({
    ok: true, platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome,
    screenshotPath, previewFrames, previewNonDarkPixelRatio, libraryManagerVerified, exportResult, artifactResults, clonedVoice, ...result
  }, null, 2)}\n`, 'utf8');
}

function createWindow(): void {
  const splash = new BrowserWindow({
    width: 430, height: 270, frame: false, resizable: false, show: false,
    alwaysOnTop: true, center: true, backgroundColor: '#0c0d10',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const splashHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:#f4f4f2;background:radial-gradient(circle at 50% 25%,#202817 0,#11140f 35%,#0c0d10 72%);display:grid;place-items:center}
    .shell{text-align:center;transform:translateY(-3px)}.logo{width:74px;height:74px;margin:0 auto 19px;border-radius:22px;background:#d9ff69;color:#111;display:grid;place-items:center;box-shadow:0 0 0 0 rgba(217,255,105,.3);animation:pulse 1.8s ease-out infinite}
    .bars{height:29px;display:flex;align-items:center;gap:4px}.bars i{display:block;width:4px;border-radius:4px;background:#111;animation:wave 1s ease-in-out infinite}.bars i:nth-child(1),.bars i:nth-child(5){height:12px}.bars i:nth-child(2),.bars i:nth-child(4){height:21px;animation-delay:.12s}.bars i:nth-child(3){height:29px;animation-delay:.24s}
    h1{font-size:20px;letter-spacing:.04em;margin:0 0 6px}h1 span{color:#82868d;font-size:11px;font-weight:500;letter-spacing:.12em;margin-left:7px}p{margin:0;color:#858990;font-size:11px}
    .loader{width:178px;height:3px;margin:22px auto 0;background:#24272b;border-radius:5px;overflow:hidden}.loader:after{content:"";display:block;width:45%;height:100%;border-radius:5px;background:#d9ff69;animation:load 1.25s ease-in-out infinite}
    @keyframes wave{0%,100%{transform:scaleY(.58)}50%{transform:scaleY(1)}}@keyframes pulse{65%,100%{box-shadow:0 0 0 22px rgba(217,255,105,0)}}@keyframes load{0%{transform:translateX(-105%)}100%{transform:translateX(325%)}}
  </style></head><body><div class="shell"><div class="logo"><div class="bars"><i></i><i></i><i></i><i></i><i></i></div></div><h1>声织 <span>VOXWEAVE</span></h1><p>正在唤醒本地成片引擎…</p><div class="loader"></div></div></body></html>`;
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  splash.once('ready-to-show', () => splash.show());
  const splashStarted = Date.now();
  const window = new BrowserWindow({
    width: 1480, height: 920, minWidth: 960, minHeight: 680,
    backgroundColor: '#0c0d10', titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d10', symbolColor: '#92959d', height: 42 }, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.once('ready-to-show', () => {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close();
      window.show(); window.focus();
    }, Math.max(0, 650 - (Date.now() - splashStarted)));
    const compositionSmokeResult = process.env.VOXWEAVE_COMPOSITION_SMOKE_RESULT;
    const smokeResult = process.env.VOXWEAVE_SMOKE_RESULT;
    if (compositionSmokeResult) {
      void runCompositionSmoke(window, compositionSmokeResult).then(() => {
        setTimeout(() => app.quit(), 350);
      }).catch(async error => {
        await mkdir(path.dirname(compositionSmokeResult), { recursive: true });
        await writeFile(compositionSmokeResult, `${JSON.stringify({
          ok: false, message: error instanceof Error ? error.message : String(error)
        }, null, 2)}\n`, 'utf8');
        console.error('Windows composition smoke failed', error);
        app.exit(1);
      });
    } else if (process.env.VOXWEAVE_SMOKE_TEST === '1' && smokeResult) {
      void (async () => {
        await mkdir(path.dirname(smokeResult), { recursive: true });
        await writeFile(smokeResult, `${JSON.stringify({
          ok: true,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          loadedUrl: window.webContents.getURL()
        }, null, 2)}\n`, 'utf8');
        setTimeout(() => app.quit(), 350);
      })().catch(error => {
        console.error('Windows smoke marker failed', error);
        app.exit(1);
      });
    }
  });
  window.on('closed', () => { if (!splash.isDestroyed()) splash.close(); });
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
}

const cliMode = process.argv.includes('--cli');
if (cliMode) {
  process.argv.splice(process.argv.indexOf('--cli'), 1);
  process.env.VOXWEAVE_ENGINE ??= path.join(process.resourcesPath, 'engine', 'qwen_tts.exe');
  process.env.VOXWEAVE_MODEL ??= path.join(process.resourcesPath, 'models', DEFAULT_TTS_MODEL);
  process.env.VOXWEAVE_FFMPEG ??= path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  process.env.VOXWEAVE_FFPROBE ??= path.join(process.resourcesPath, 'ffmpeg', 'ffprobe.exe');
  void import('../cli/voxweave.js');
} else app.whenReady().then(async () => {
  if (await resetTtsDevelopmentData(app.getPath('userData'), settings.get('ttsSetupVersion'))) {
    settings.set('voiceProfiles', []);
    settings.delete('modelDir');
    settings.delete('lastProjectId');
    settings.set('ttsSetupVersion', TTS_SETUP_VERSION);
  }
  const projectsRoot = path.join(app.getPath('userData'), 'projects');
  const editPlans = new EditPlanStore(projectsRoot);
  const library = new LibraryDatabase(path.join(app.getPath('userData'), 'library', 'assets.sqlite'));
  const semanticEmbedder = new LocalLlamaEmbedder(semanticPaths);
  const semanticReranker = new SemanticReranker(semanticEmbedder);
  app.on('before-quit', () => semanticEmbedder.dispose());
  for (const asset of library.list(10000)) {
    if (asset.license.source !== 'pexels') continue;
    const autoTags = [...new Set([...automaticTags(asset), ...cleanAutomaticTags(asset.autoTags)])];
    if (JSON.stringify(autoTags) !== JSON.stringify(asset.autoTags)) {
      library.upsert({ ...asset, autoTags, tags: [...new Set([...autoTags, ...asset.manualTags])] });
    }
  }
  const probePath = configuredPaths().ffprobePath;
  const mediaProbe = new FallbackMediaProbe(probePath ? new FfprobeMediaProbe(probePath) : undefined);
  const projectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
  const idsSchema = z.array(z.string().min(1)).min(1).max(500);
  const pexels = new PexelsClient(() => {
    if (process.env.PEXELS_API_KEY) return process.env.PEXELS_API_KEY;
    const encrypted = settings.get('pexelsKeyEncrypted');
    return encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
  });
  const makeImporter = () => new AssetImporter(library, mediaProbe, path.join(app.getPath('userData'), 'library', 'derived'),
    configuredPaths().ffmpegPath ? new FfmpegThumbnailer(configuredPaths().ffmpegPath!) : undefined);
  const makeRenderer = (plan: EditPlan) => new HyperframesPreviewRenderer(assetId => {
    if (assetId === 'source-video' && plan.input.sourceVideoPath) return plan.input.sourceVideoPath;
    const asset = library.byId(assetId);
    if (!asset) throw new Error(`素材 ${assetId} 不存在`);
    return asset.filePath;
  }, rendererTools());
  const preparePreview = async (plan: EditPlan) => {
    const workspace = path.join(projectsRoot, plan.id, 'preview', `r${plan.revision}`);
    const prepared = await makeRenderer(plan).prepare(plan, workspace);
    return { plan, preview: { entryUrl: previews.register(`${plan.id}-${plan.revision}`, workspace),
      durationMs: prepared.durationMs, width: plan.canvas.width, height: plan.canvas.height } };
  };

  protocol.handle('voxweave-library', request => {
    const url = new URL(request.url);
    const asset = library.byId(url.hostname);
    const file = url.pathname === '/thumbnail' ? asset?.thumbnailPath : url.pathname === '/media' ? asset?.filePath : undefined;
    if (!file) return new Response('素材不存在', { status: 404 });
    return net.fetch(pathToFileURL(file).href, { headers: request.headers });
  });

  protocol.handle('voxweave-preview', request => {
    try { return net.fetch(previews.resolve(request.url).href); }
    catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 404 }); }
  });

  ipcMain.handle('engine:status', () => configuredEngine().status());
  ipcMain.handle('voice:list', () => settings.get('voiceProfiles') ?? []);
  ipcMain.handle('voice:clone', async (_event, value: unknown) => {
    const input = z.object({ name: z.string().trim().min(1).max(60), referenceAudioPath: z.string().min(1) }).strict().parse(value);
    const id = randomUUID();
    const profile: VoiceProfile = { id, name: input.name, kind: 'clone',
      path: path.join(app.getPath('userData'), 'voices', `${id}.qvoice`), createdAt: new Date().toISOString() };
    await configuredEngine().createVoiceProfile(input.referenceAudioPath,
      path.join(resourceRoot(), 'models', CLONE_TTS_MODEL), profile.path!);
    settings.set('voiceProfiles', [...(settings.get('voiceProfiles') ?? []), profile]);
    return profile;
  });
  ipcMain.handle('engine:configure', async (_event, value: unknown) => {
    const config = z.object({ enginePath: z.string().optional(), modelDir: z.string().optional() }).strict().parse(value);
    if (config.enginePath !== undefined) settings.set('enginePath', config.enginePath);
    if (config.modelDir !== undefined) settings.set('modelDir', config.modelDir);
    return configuredEngine().status();
  });
  ipcMain.handle('semantic:status', () => ({
    enginePath: semanticPaths().enginePath ?? settings.get('semanticEnginePath') ?? '',
    modelPath: semanticPaths().modelPath ?? settings.get('semanticModelPath') ?? '',
    configured: Boolean(semanticPaths().enginePath && semanticPaths().modelPath)
  }));
  ipcMain.handle('semantic:configure', (_event, value: unknown) => {
    const config = z.object({ enginePath: z.string().trim().max(1000), modelPath: z.string().trim().max(1000) }).strict().parse(value);
    if ((config.enginePath || config.modelPath) && (!existsSync(config.enginePath) || !existsSync(config.modelPath))) {
      throw new Error('找不到 llama-server 或 embedding 模型文件');
    }
    semanticEmbedder.dispose();
    semanticReranker.clear();
    settings.set('semanticEnginePath', config.enginePath);
    settings.set('semanticModelPath', config.modelPath);
    settings.set('semanticEnabled', Boolean(config.enginePath && config.modelPath));
    return { ...config, configured: Boolean(config.enginePath && config.modelPath) };
  });
  ipcMain.handle('dialog:choose-file', async (_event, value: unknown) => {
    const kind = z.enum(['audio', 'video', 'engine', 'model', 'semantic-engine', 'semantic-model']).parse(value);
    if (kind === 'model') {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择 Qwen3-TTS 模型目录' });
      return result.canceled ? null : result.filePaths[0];
    }
    const filters = kind === 'audio'
      ? [{ name: '音频', extensions: ['wav', 'flac', 'mp3', 'ogg', 'opus', 'm4a', 'aac'] }]
      : kind === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }]
        : kind === 'semantic-model' ? [{ name: 'GGUF 模型', extensions: ['gguf'] }]
        : kind === 'semantic-engine' ? [{ name: 'llama-server', extensions: ['exe', 'bin', '*'] }]
        : [{ name: 'Qwen3-TTS 引擎', extensions: ['exe', 'bin', '*'] }];
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters, title: kind === 'audio' ? '选择参考音频' : kind === 'video' ? '选择原始视频' : kind === 'semantic-model' ? '选择 embedding GGUF 模型' : kind === 'semantic-engine' ? '选择 llama-server 可执行文件' : '选择 qwen_tts 引擎' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:choose-output', async (_event, defaultName: string, format: AudioFormat = 'wav') => {
    const labels: Record<AudioFormat, string> = { wav: 'WAV 无损音频', flac: 'FLAC 无损音频', mp3: 'MP3 音频', opus: 'Ogg Opus 音频', m4a: 'M4A / AAC 音频' };
    const result = await dialog.showSaveDialog({ defaultPath: path.basename(defaultName), filters: [{ name: labels[format], extensions: [format === 'opus' ? 'ogg' : format] }] });
    if (!result.canceled && result.filePath) allowedShellPaths.add(path.resolve(result.filePath));
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('composition:create-draft', async (_event, request: unknown) => {
    const plan = planDraft(request); await editPlans.save(plan); settings.set('lastProjectId', plan.id); return plan;
  });
  ipcMain.handle('composition:generate', (event, input: unknown) => {
    const request = GenerateCompositionRequestSchema.parse(input) as GenerateCompositionRequest;
    const voiceProfile = (settings.get('voiceProfiles') ?? []).find(profile => profile.id === request.voiceId);
    if (voiceProfile && (!voiceProfile.path || !existsSync(voiceProfile.path))) throw new Error('克隆音色文件不存在，请重新克隆');
    const { language: _language, temperature: _temperature, precision: _precision, bgm, audio, playbackRate, ...draftRequest } = request;
    const draft = planDraft(draftRequest);
    const plan = EditPlanSchema.parse({ ...draft, bgm: bgm ?? draft.bgm,
      audio: audio ?? draft.audio, output: { ...draft.output, playbackRate: playbackRate ?? 1 } });
    if (plan.bgm.enabled) {
      const asset = plan.bgm.assetId && library.byId(plan.bgm.assetId);
      if (!asset || asset.type !== 'audio' || asset.license.status === 'unknown') throw new Error('请选择授权明确的音频素材');
    }
    const jobId = randomUUID();
    const controller = new AbortController();
    const modelDir = configuredPaths().modelDir;
    const engine = configuredEngine(modelDir);
    compositionJobs.set(jobId, { controller, engine });
    settings.set('lastProjectId', plan.id);
    const projectDir = path.join(projectsRoot, plan.id);
    const emit = (phase: CompositionProgressEvent['phase'], progress: number, message: string, extra: Partial<CompositionProgressEvent> = {}) =>
      sendComposition(event.sender, { jobId, phase, progress, message, ...extra });
    void (async () => {
      await editPlans.save(plan);
      emit('drafting', 0.04, '工程草稿已保存');
      const model = await describeTtsModel(modelDir);
      const voiceFingerprint = voiceProfile?.path ? createHash('sha256').update(await readFile(voiceProfile.path)).digest('hex') : 'preset';
      const narration = await new NarrationService({
        cacheDir: path.join(app.getPath('userData'), 'cache', 'narration'),
        synthesizer: new QwenNarrationSynthesizer(engine, voiceProfile?.path ? new Map([[voiceProfile.id, voiceProfile.path]]) : undefined), probe: mediaProbe,
        voice: {
          language: request.language ?? 'Chinese', temperature: request.temperature ?? 0.5,
          topK: 50, topP: 1, precision: request.precision ?? 'int8',
          engineVersion: 'qwen3-tts-c-v0.2.1', modelVersion: `${model.identity}:${voiceFingerprint}`,
          instruct: model.instructionControl ? AUTOMATIC_NARRATION_INSTRUCTION : undefined
        }
      }).generate(plan, path.join(projectDir, 'artifacts'), controller.signal, progress =>
        emit('narrating', 0.05 + progress.progress * 0.55, progress.message));
      emit('aligning', 0.63, '正在按最终旁白对齐字幕和分镜…');
      const alignedNarration = await alignNarration(narration, plan.scenes,
        senseVoiceNarrationTranscriber(path.join(resourceRoot(), 'models', 'sensevoice-small')), controller.signal,
        message => emit('aligning', 0.69, `该段字幕使用语音区间估时：${message}`));
      emit('resolving', 0.74, '正在按真实旁白时长解析分镜…');
      const sourceMetadata = plan.input.sourceVideoPath ? await mediaProbe.probe(plan.input.sourceVideoPath) : undefined;
      let resolved = resolveEditPlan(plan, { narration: alignedNarration, sourceMetadata });
      await editPlans.save(resolved);
      emit('selecting', 0.78, '正在从本地素材库选择画面…');
      const selected = selectBroll(resolved, library);
      if (selected !== resolved) { resolved = selected; await editPlans.save(resolved); }
      emit('compiling', 0.88, '正在编译固定模板预览…');
      const previewWorkspace = path.join(projectDir, 'preview', `r${resolved.revision}`);
      await mkdir(previewWorkspace, { recursive: true });
      const renderer = makeRenderer(resolved);
      const prepared = await renderer.prepare(resolved, previewWorkspace);
      const entryUrl = previews.register(`${resolved.id}-${resolved.revision}`, previewWorkspace);
      emit('complete', 1, '自动成片预览已就绪', {
        plan: resolved,
        preview: { entryUrl, durationMs: prepared.durationMs, width: resolved.canvas.width, height: resolved.canvas.height }
      });
    })().catch(async error => {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const message = error instanceof Error ? error.message : String(error);
      let failedPlan: EditPlan | undefined;
      if (!cancelled) {
        try {
          const current = await editPlans.read(plan.id);
          failedPlan = EditPlanSchema.parse({
            ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), status: 'error',
            error: { code: 'COMPOSITION_FAILED', message }
          });
          await editPlans.save(failedPlan);
        } catch { /* The last valid revision remains recoverable. */ }
      }
      emit(cancelled ? 'cancelled' : 'error', 0, cancelled ? '生成已取消，工程草稿已保留' : message, { recoverable: true, plan: failedPlan });
    }).finally(() => compositionJobs.delete(jobId));
    return { jobId, projectId: plan.id };
  });
  ipcMain.handle('composition:cancel', (_event, value: unknown) => {
    const jobId = z.string().uuid().parse(value);
    const job = compositionJobs.get(jobId); job?.controller.abort(); job?.engine.cancel();
  });
  ipcMain.handle('composition:resume-last', async () => {
    const projectId = settings.get('lastProjectId');
    if (!projectId) return null;
    const plan = await editPlans.read(projectId);
    if (projectLocks.has(projectId)) return { plan };
    if (!['resolved', 'complete', 'rendering'].includes(plan.status)) return { plan };
    if (plan.status === 'rendering') {
      const recovered = EditPlanSchema.parse({ ...plan, status: 'resolved', revision: plan.revision + 1, updatedAt: new Date().toISOString() });
      await editPlans.save(recovered);
      return preparePreview(recovered);
    }
    if (plan.output.outputPath) allowedShellPaths.add(path.resolve(plan.output.outputPath));
    return preparePreview(plan);
  });
  ipcMain.handle('composition:scene-candidates', async (_event, projectIdValue: unknown, sceneIdValue: unknown, queryValue: unknown, throughSceneIdValue: unknown) => {
    const projectId = projectIdSchema.parse(projectIdValue);
    const sceneId = z.string().min(1).max(160).parse(sceneIdValue);
    const query = z.string().trim().max(150).default('').parse(queryValue);
    const throughSceneId = z.string().min(1).max(160).optional().parse(throughSceneIdValue);
    const plan = await editPlans.read(projectId);
    return listSceneCandidates(plan, sceneId, library, { query, throughSceneId, ffmpegPath: configuredPaths().ffmpegPath,
      semantic: semanticPaths().enginePath ? semanticReranker : undefined });
  });
  ipcMain.handle('composition:replace-scene', async (_event, projectIdValue: unknown, sceneIdValue: unknown, choiceValue: unknown) => {
    const projectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u).parse(projectIdValue);
    const sceneId = z.string().min(1).max(160).parse(sceneIdValue);
    if (projectLocks.has(projectId)) throw new Error('工程正在导出或更新，请稍后再试');
    projectLocks.add(projectId);
    try {
    const plan = await editPlans.read(projectId);
    let updated: EditPlan;
    try {
      const resolved = { ...plan, status: plan.status === 'complete' ? 'resolved' as const : plan.status };
      const choice = choiceValue === undefined ? undefined : z.discriminatedUnion('type', [
        z.object({ type: z.literal('asset'), assetId: z.string().min(1).max(160), sourceInMs: z.number().int().nonnegative().optional(), throughSceneId: z.string().min(1).max(160).optional() }).strict(),
        z.object({ type: z.literal('kinetic-text'), throughSceneId: z.string().min(1).max(160).optional() }).strict()
      ]).parse(choiceValue);
      updated = choice ? applySceneChoice(resolved, sceneId, choice, library) : replaceSceneAsset(resolved, sceneId, library);
    } catch (error) {
      if (error instanceof NoReplacementAssetError) return { status: 'unavailable' as const, message: error.message };
      throw error;
    }
    updated.output.outputPath = undefined;
    const result = await preparePreview(updated); await editPlans.save(updated);
    return { status: 'replaced' as const, ...result };
    } finally { projectLocks.delete(projectId); }
  });
  ipcMain.handle('library:import', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '导入本地素材', filters: [{ name: '媒体素材', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'wav', 'flac', 'mp3', 'm4a', 'ogg', 'opus', 'aac'] }] });
    const report: ImportReport = { assets: [], errors: [] };
    if (result.canceled) return report;
    const importer = makeImporter();
    for (const filePath of result.filePaths) {
      try { report.assets.push(await importer.import(ImportAssetRequestSchema.parse({ filePath }))); }
      catch (error) { report.errors.push({ name: path.basename(filePath), message: error instanceof Error ? error.message : String(error) }); }
    }
    return report;
  });
  ipcMain.handle('library:import-file', (_event, value: unknown) =>
    makeImporter().import(ImportAssetRequestSchema.parse({ filePath: z.string().min(1).parse(value) })));
  ipcMain.handle('library:list', () => library.list(10000));
  ipcMain.handle('library:search', (_event, query: unknown, type: unknown) => searchAssets(library,
    SearchAssetsRequestSchema.parse({ query, types: type ? [type] : ['video', 'image', 'audio'], limit: 100 })).map(result => result.asset));
  ipcMain.handle('library:tags', (_event, value: unknown) => {
    const request = UpdateTagsSchema.parse(value);
    for (const id of request.ids) {
      const asset = library.byId(id); if (!asset) continue;
      const manualTags = [...new Set([...(request.mode === 'append' ? asset.manualTags : []), ...request.tags])];
      library.upsert({ ...asset, manualTags, tags: [...new Set([...asset.autoTags, ...manualTags])] });
    }
  });
  ipcMain.handle('library:auto-tags', (_event, values: unknown) => {
    for (const id of idsSchema.parse(values)) {
      const asset = library.byId(id); if (!asset) continue;
      const autoTags = [...new Set([...automaticTags(asset), ...(asset.license.source === 'pexels' ? cleanAutomaticTags(asset.autoTags) : [])])];
      library.upsert({ ...asset, autoTags, tags: [...new Set([...autoTags, ...asset.manualTags])] });
    }
  });
  ipcMain.handle('library:remove', (_event, values: unknown) => {
    if (projectLocks.size || compositionJobs.size) throw new Error('请等待当前任务完成后移除素材');
    for (const id of idsSchema.parse(values)) library.remove(id);
  });
  ipcMain.handle('pexels:status', () => ({ configured: Boolean(process.env.PEXELS_API_KEY || settings.get('pexelsKeyEncrypted')) }));
  ipcMain.handle('pexels:configure', (_event, value: unknown) => {
    const key = z.string().trim().max(300).parse(value);
    if (!key) { settings.delete('pexelsKeyEncrypted'); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，可通过 PEXELS_API_KEY 环境变量配置');
    settings.set('pexelsKeyEncrypted', safeStorage.encryptString(key).toString('base64'));
  });
  ipcMain.handle('pexels:search', (_event, value) => pexels.search(value));
  ipcMain.handle('pexels:download', async (_event, value: unknown) => {
    const { item, filePath } = await pexels.download(z.string().max(100).parse(value), path.join(app.getPath('userData'), 'library', 'downloads'));
    try {
      const asset = await makeImporter().import({ filePath, tags: item.tags,
        license: { status: 'licensed', source: 'pexels', sourceUrl: item.sourceUrl, author: item.author, licenseUrl: 'https://www.pexels.com/license/' } });
      if (asset.filePath !== filePath) { await rm(filePath, { force: true }); return asset; }
      const autoTags = [...new Set([...asset.autoTags, ...item.tags])];
      return library.upsert({ ...asset, name: item.name, autoTags, manualTags: [], tags: autoTags });
    } catch (error) { await rm(filePath, { force: true }); throw error; }
  });
  ipcMain.handle('library:open-source', (_event, value: unknown) => shell.openExternal(assertPexelsUrl(z.string().url().parse(value), 'page')));
  ipcMain.handle('composition:audio', async (_event, idValue: unknown, value: unknown) => {
    const id = projectIdSchema.parse(idValue);
    if (projectLocks.has(id)) throw new Error('工程正在处理，请稍后再试');
    projectLocks.add(id);
    try {
      const plan = await editPlans.read(id);
      if (!['resolved', 'complete'].includes(plan.status)) throw new Error('请先生成预览');
      const settings = z.object({ bgm: EditPlanSchema.shape.bgm, audio: EditPlanSchema.shape.audio,
        playbackRate: z.number().min(.25).max(4).optional() }).strict().parse(value);
      const candidate = EditPlanSchema.parse({ ...plan, bgm: settings.bgm, audio: settings.audio, status: 'resolved', revision: plan.revision + 1,
        updatedAt: new Date().toISOString(), output: { ...plan.output, playbackRate: settings.playbackRate ?? plan.output.playbackRate, outputPath: undefined } });
      if (candidate.bgm.enabled) {
        const asset = candidate.bgm.assetId && library.byId(candidate.bgm.assetId);
        if (!asset || asset.type !== 'audio' || asset.license.status === 'unknown') throw new Error('请选择授权明确的音频素材');
      }
      const result = await preparePreview(candidate);
      await editPlans.save(candidate);
      return result;
    } finally { projectLocks.delete(id); }
  });
  ipcMain.handle('composition:export', async (event, idValue: unknown) => {
    const id = projectIdSchema.parse(idValue);
    if (projectLocks.has(id) || exportJobs.size) throw new Error('已有导出或工程更新任务，请稍后再试');
    projectLocks.add(id);
    try {
      const plan = await editPlans.read(id);
      if (!['resolved', 'complete'].includes(plan.status)) throw new Error('请先生成可播放预览');
      const result = process.env.VOXWEAVE_COMPOSITION_SMOKE_RESULT && process.env.VOXWEAVE_EXPORT_SMOKE_OUTPUT
        ? { canceled: false, filePath: process.env.VOXWEAVE_EXPORT_SMOKE_OUTPUT }
        : await dialog.showSaveDialog({ title: '导出 MP4', defaultPath: '声织成片.mp4', filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
      if (result.canceled || !result.filePath) { projectLocks.delete(id); return null; }
      const outputPath = result.filePath;
      const sourcePaths = [plan.narration.audioPath, plan.input.sourceVideoPath, ...library.list(10000).map(asset => asset.filePath)].filter(Boolean);
      if (sourcePaths.some(file => path.resolve(file!).toLowerCase() === path.resolve(outputPath).toLowerCase())) throw new Error('导出路径不能覆盖原始素材');
      const jobId = randomUUID(); const renderer = makeRenderer(plan);
      const job = { renderer, cancelled: false }; exportJobs.set(jobId, job);
      const emit = (payload: Omit<import('../shared/types.js').ExportProgress, 'jobId'>) => {
        if (!event.sender.isDestroyed()) event.sender.send('composition:export-progress', { ...payload, jobId });
      };
      void (async () => {
        emit({ phase: 'preparing', progress: 0, message: '正在准备画面、字幕和混音…' });
        const rendering = EditPlanSchema.parse({ ...plan, revision: plan.revision + 1, status: 'rendering', updatedAt: new Date().toISOString() });
        await editPlans.save(rendering);
        try {
          const prepared = await renderer.prepare(rendering, path.join(projectsRoot, id, 'exports', jobId));
          if (job.cancelled) throw new Error('导出已取消');
          await renderer.render({ jobId, composition: prepared, outputPath }, progress => {
            if (progress.phase !== 'complete') emit(progress);
          });
          await editPlans.save(EditPlanSchema.parse({ ...rendering, revision: rendering.revision + 1, status: 'complete',
            updatedAt: new Date().toISOString(), output: { ...plan.output, outputPath } }));
          allowedShellPaths.add(path.resolve(outputPath));
          emit({ phase: 'complete', progress: 1, message: 'MP4 已导出', outputPath });
        } catch (error) {
          await editPlans.save(EditPlanSchema.parse({ ...plan, revision: rendering.revision + 1, status: 'resolved', updatedAt: new Date().toISOString() }));
          throw error;
        }
      })().catch(error => emit({ phase: job.cancelled ? 'cancelled' : 'error', progress: 0, message: error instanceof Error ? error.message : String(error) }))
        .finally(() => { exportJobs.delete(jobId); projectLocks.delete(id); });
      return { jobId };
    } catch (error) { projectLocks.delete(id); throw error; }
  });
  ipcMain.handle('composition:export-artifact', async (_event, idValue: unknown, kindValue: unknown) => {
    const id = projectIdSchema.parse(idValue);
    const kind = z.enum(['narration-mp3', 'mixed-mp3', 'srt', 'ass']).parse(kindValue);
    if (projectLocks.has(id)) throw new Error('工程正在处理，请稍后再试');
    projectLocks.add(id);
    let temporary: string | undefined;
    try {
      const plan = await editPlans.read(id);
      if (!['resolved', 'complete'].includes(plan.status)) throw new Error('请先生成旁白和字幕');
      const audio = kind.endsWith('mp3');
      const extension = audio ? 'mp3' : kind;
      const name = kind === 'narration-mp3' ? '旁白' : kind === 'mixed-mp3' ? '混合音轨' : '字幕';
      const smokeDirectory = process.env.VOXWEAVE_COMPOSITION_SMOKE_RESULT && process.env.VOXWEAVE_ARTIFACT_SMOKE_DIR;
      if (smokeDirectory) await mkdir(smokeDirectory, { recursive: true });
      const result = smokeDirectory ? { canceled: false, filePath: path.join(smokeDirectory, `${kind}.${extension}`) }
        : await dialog.showSaveDialog({ title: `导出${name}`, defaultPath: `声织${name}.${extension}`,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
      if (result.canceled || !result.filePath) return null;
      const outputPath = result.filePath;
      const sourcePaths = [plan.narration.audioPath, plan.input.sourceVideoPath, ...library.list(10000).map(asset => asset.filePath)].filter(Boolean);
      if (sourcePaths.some(file => path.resolve(file!).toLowerCase() === path.resolve(outputPath).toLowerCase())) throw new Error('导出路径不能覆盖原始素材');
      temporary = path.join(path.dirname(outputPath), `.voxweave-${randomUUID()}.${extension}`);
      if (audio) {
        const ffmpeg = configuredPaths().ffmpegPath;
        if (!ffmpeg) throw new Error('导出 MP3 需要内置 FFmpeg');
        const workspace = path.join(projectsRoot, id, 'audio-exports', randomUUID());
        try {
          const input = kind === 'mixed-mp3' ? await makeRenderer(plan).prepareAudio(plan, workspace) : plan.narration.audioPath!;
          const rate = plan.output.playbackRate;
          const tempo = rate < .5 ? `atempo=0.5,atempo=${rate / .5}` : rate > 2 ? `atempo=2,atempo=${rate / 2}` : `atempo=${rate}`;
          await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn',
            ...(kind === 'narration-mp3' && rate !== 1 ? ['-af', tempo] : []), '-c:a', 'libmp3lame', '-b:a', '192k', temporary],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        } finally { await rm(workspace, { recursive: true, force: true }); }
      } else await writeFile(temporary, kind === 'srt' ? exportSrt(plan) : exportAss(plan), 'utf8');
      await rename(temporary, outputPath);
      allowedShellPaths.add(path.resolve(outputPath));
      return { outputPath };
    } finally {
      if (temporary) await rm(temporary, { force: true });
      projectLocks.delete(id);
    }
  });
  ipcMain.handle('composition:cancel-export', async (_event, value: unknown) => {
    const id = z.string().uuid().parse(value); const job = exportJobs.get(id);
    if (job) { job.cancelled = true; await job.renderer.cancel(id); }
  });
  ipcMain.handle('engine:synthesize', (event, request: SynthesisRequest) => {
    const jobId = randomUUID(); const engine = configuredEngine(); audioJobs.set(jobId, engine);
    void engine.synthesize(request, progress => event.sender.send('engine:progress', { ...progress, jobId }))
      .catch(error => event.sender.send('engine:progress', { jobId, phase: 'error', message: error instanceof Error ? error.message : String(error) }))
      .finally(() => audioJobs.delete(jobId));
    return { jobId };
  });
  ipcMain.handle('engine:cancel', (_event, jobId: string) => { audioJobs.get(jobId)?.cancel(); audioJobs.delete(jobId); });
  ipcMain.handle('shell:reveal', (_event, target: string) => {
    const resolved = path.resolve(target); if (!allowedShellPaths.has(resolved)) throw new Error('未授权的文件路径'); shell.showItemInFolder(resolved);
  });
  ipcMain.handle('shell:open', async (_event, target: string) => {
    const resolved = path.resolve(target); if (!allowedShellPaths.has(resolved)) throw new Error('未授权的文件路径'); await shell.openPath(resolved);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

if (!cliMode) app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
