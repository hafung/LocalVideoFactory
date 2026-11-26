import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';
import { QwenEngine } from '../dist-electron/electron/engine.js';
import { planDraft } from '../dist-electron/electron/composition/planner.js';
import { NarrationService } from '../dist-electron/electron/composition/narration.js';
import { QwenNarrationSynthesizer } from '../dist-electron/electron/composition/qwen-narration.js';
import { alignNarration, senseVoiceNarrationTranscriber } from '../dist-electron/electron/alignment/narration.js';
import { resolveEditPlan } from '../dist-electron/electron/composition/resolver.js';
import { FfprobeMediaProbe } from '../dist-electron/electron/media/probe.js';
import { HyperframesPreviewRenderer } from '../dist-electron/electron/renderers/hyperframes.js';
import { writePublishBundle } from '../dist-electron/electron/publishing.js';
import { importTalkVideo, analyzeTalkVideo, prepareTalkAudio } from '../dist-electron/electron/talking-head/media.js';
import { pauseCuts, talkCues, updateTalkProject } from '../dist-electron/electron/talking-head/editing.js';
import { compileTalkTemplate } from '../dist-electron/electron/talking-head/compiler.js';
import { TalkProjectSchema, talkDuration } from '../dist-electron/shared/talking-head.js';

const root = path.resolve(import.meta.dirname, '..');
const demos = path.join(root, 'docs', 'demos');
const work = path.join(root, '.windows-smoke', 'publishing-demos');
const resources = path.join(root, 'resources');
const tools = { ffmpegPath: process.env.VOXWEAVE_FFMPEG ?? path.join(resources, 'ffmpeg', 'ffmpeg.exe'),
  ffprobePath: process.env.VOXWEAVE_FFPROBE ?? path.join(resources, 'ffmpeg', 'ffprobe.exe'),
  chromePath: process.env.VOXWEAVE_CHROME ?? path.join(resources, 'browser', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  senseVoiceRoot: path.join(resources, 'models', 'sensevoice-small') };
const run = promisify(execFile);
const ff = (...args) => run(tools.ffmpegPath, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
const probe = new FfprobeMediaProbe(tools.ffprobePath);
const videoOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'];
const signal = new AbortController().signal;
await mkdir(work, { recursive: true });
const attempt = await mkdtemp(path.join(work, 'run-'));
const script = (await readFile(path.join(demos, 'frameskiff-script.txt'), 'utf8')).trim();
const modelDir = path.join(resources, 'models', 'qwen3-tts-1.7b-customvoice');
const engine = new QwenEngine({ enginePath: process.env.VOXWEAVE_QWEN_TTS ?? path.join(resources, 'engine', 'qwen_tts.exe'), modelDir });
const service = new NarrationService({ cacheDir: path.join(work, 'narration-cache'), probe,
  synthesizer: new QwenNarrationSynthesizer(engine), voice: { language: 'Chinese', temperature: .5, topK: 50, topP: 1,
    precision: 'int8', engineVersion: 'bundled', modelVersion: 'qwen3-tts-1.7b-customvoice' } });
const draft = planDraft({ script, voiceId: 'vivian', aspectRatio: '9:16', captionStyle: 'brand-minimal' });
const speech = await service.generate(draft, attempt, signal, event => console.log(event.message));
const narration = await alignNarration(speech, draft.scenes, senseVoiceNarrationTranscriber(tools.senseVoiceRoot), signal, console.warn, 'phrase');
const resolved = resolveEditPlan(draft, { narration });
const browser = await puppeteer.launch({ executablePath: tools.chromePath, headless: true, args: ['--no-sandbox'] });

const img = async file => `data:image/png;base64,${(await readFile(path.join(root, file))).toString('base64')}`;
const icon = await img('build/icon.png');
const studio = await img('docs/screenshots/studio.png');
const caption = await img('docs/screenshots/captions.png');
const graphic = (label, note, image) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 78% 24%,#304338,#111c22 62%);color:#f1f5ed;
font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif;padding:8%}header{display:flex;align-items:center;gap:20px;font-size:42px;font-weight:bold}
header img{width:65px;height:65px}h1{font-size:88px;line-height:1.12;margin:18% 0 4%;letter-spacing:-.05em}p{font-size:34px;color:#b7c6bb;margin:0 0 10%}
.window{position:absolute;inset:41% 8% 25%;border:2px solid #6c8354;border-radius:30px;box-shadow:0 25px 70px #0007;overflow:hidden;background:#0b1114}
.window img{position:absolute;width:154%;max-width:none;height:auto;top:0;left:-23%}.line{width:96px;height:8px;background:#d9ff69;margin-bottom:22px}</style>
<header><img src="${icon}">帧舟 FrameSkiff</header><h1>${label}</h1><div class="line"></div><p>${note}</p><div class="window"><img src="${image}"></div>`;
const frames = new Map();
async function frame(id, label, note, image) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1080, height: 1920 });
    await page.setContent(graphic(label, note, image));
    const file = path.join(attempt, `${id}.jpg`);
    await page.screenshot({ type: 'jpeg', quality: 92, path: file });
    frames.set(id, file);
  } finally { await page.close(); }
}
try {
  await frame('write', '从文案开始', '输入内容，选择音色与画幅', studio);
  await frame('voice', '在本机生成', '配音与字幕沿声音时间轴对齐', studio);
  await frame('edit', '调整这一段', '在分镜卡片换画面，校正字幕', caption);
  await frame('publish', '交付发布包', '视频、封面和文案一起保存', studio);
  await frame('before', '剪辑前', '同一段口播原声 · 保留原停顿', studio);
  await frame('after', '剪辑后', '缩短长停顿 · 加入口播字幕', studio);
} finally { await browser.close(); }

// The demonstration uses the actual composition API. Replace one scene with an edited caption view.
const scenes = resolved.scenes.map((scene, index) => ({ ...scene, visual: { ...scene.visual, type: 'image', fit: 'contain',
  motion: 'none', assetId: index === 0 ? 'write' : index >= resolved.scenes.length - 2 ? 'publish' : 'voice' } }));
const changedScene = Math.floor(scenes.length * .55);
scenes[changedScene] = { ...scenes[changedScene], visual: { ...scenes[changedScene].visual, assetId: 'edit' } };
const renderer = new HyperframesPreviewRenderer(id => frames.get(id), tools);
const video = path.join(attempt, 'script-to-video.mp4');
await renderer.render({ jobId: 'demo-script', composition: await renderer.prepare({ ...resolved, scenes }, path.join(attempt, 'composition')), outputPath: video },
  event => { if (event.phase === 'complete') console.log(event.message); });

// Use locally synthesized narration as an openly distributable recording proxy.
// Both versions are built from the same first seconds of that original audio.
const source = path.join(attempt, 'talk-source.mp4');
const pauseAt = (narration.sceneTimings.at(0)?.endMs ?? 3000) / 1000;
const sourceEnd = Math.max(pauseAt + 3, (narration.sceneTimings.at(1)?.endMs ?? 8000) / 1000);
await ff('-loop', '1', '-framerate', '30', '-i', frames.get('before'), '-i', narration.audioPath,
  '-filter_complex', `[1:a]atrim=start=0:end=${pauseAt},asetpts=PTS-STARTPTS[a];anullsrc=r=24000:cl=mono,atrim=duration=2.6[s];[1:a]atrim=start=${pauseAt}:end=${sourceEnd},asetpts=PTS-STARTPTS[b];[a][s][b]concat=n=3:v=0:a=1[voice]`,
  '-map', '0:v:0', '-map', '[voice]', '-shortest', ...videoOptions, source);
const projectDirectory = path.join(attempt, 'talk-project');
const imported = await importTalkVideo(source, projectDirectory, tools, signal);
const analysis = await analyzeTalkVideo(projectDirectory, imported.durationMs, tools, signal, (_, message) => console.log(message));
const now = new Date().toISOString();
const project = TalkProjectSchema.parse({ schemaVersion: 1, id: '817bd7e9-7676-4516-96cc-570d672eda4f', mode: 'talking-head',
  revision: 1, createdAt: now, updatedAt: now, source: imported, strength: 'natural', captions: {}, cues: talkCues(analysis.tokens),
  cuts: [], speech: analysis.speech, silence: analysis.silence, audio: {} });
project.cuts = pauseCuts(project);
assert.ok(project.cuts.some(cut => cut.applied));
const edited = updateTalkProject(project, { revision: 1, overlays: [{ id: 'demo-card', cueId: project.cues.at(-1).id,
  type: 'callout', text: '长停顿已缩短', layout: 'pip', position: 'top-right', sourceInMs: 0, enabled: true }] });
const readAsset = () => { throw new Error('The demo uses graphics only'); };
const cutAudio = await prepareTalkAudio(edited, projectDirectory, tools, readAsset, signal);
const after = path.join(attempt, 'talk-after.mp4');
await renderer.render({ jobId: 'demo-talk', composition: await compileTalkTemplate(edited, projectDirectory, path.join(attempt, 'talk'), cutAudio, readAsset), outputPath: after }, () => {});
const comparison = path.join(attempt, 'talking-head.mp4');
await ff('-i', source, '-i', after, '-loop', '1', '-framerate', '30', '-i', frames.get('after'),
  '-filter_complex', '[2:v]crop=1080:530:0:0[header];[1:v][header]overlay=0:0:shortest=1[edited];[0:v]setsar=1[original];[edited]setsar=1[next];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[raw];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[clean];[original][raw][next][clean]concat=n=2:v=1:a=1[v][a]',
  '-map', '[v]', '-map', '[a]', ...videoOptions, comparison);

await copyFile(source, path.join(demos, 'frameskiff-talk-source.mp4'));
for (const [name, file, title, description] of [
  ['frameskiff-script', video, '帧舟文案成片', '输入文案，在本机生成旁白与字幕。更换分镜画面后，保存视频、封面与发布文案。'],
  ['frameskiff-talk', comparison, '帧舟口播精剪前后对照', '对同一段演示原声缩短长停顿、生成字幕并添加提示卡。样片使用合成原声演示。']
]) {
  const bundle = await writePublishBundle(attempt, file, { platform: 'general', frameMs: 800, title,
    coverTitle: title, description, tags: '帧舟 本地剪辑' }, tools);
  await copyFile(bundle.outputPath, path.join(demos, `${name}.mp4`));
  await copyFile(path.join(path.dirname(bundle.outputPath), '封面.jpg'), path.join(demos, `${name}.jpg`));
  await copyFile(path.join(path.dirname(bundle.outputPath), '发布文案.txt'), path.join(demos, `${name}-post.txt`));
  console.log(`${name} · ${bundle.summary}`);
}
console.log(`口播精剪 ${imported.durationMs} → ${talkDuration(edited)} ms`);
await rm(attempt, { recursive: true, force: true });
