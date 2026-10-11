// Windows Node: real mixed audio, HTML player and MP4, without running TTS.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDraftEditPlan, EditPlanSchema } from '../dist-electron/shared/edit-plan.js';
import { resolveEditPlan } from '../dist-electron/electron/composition/resolver.js';
import { HyperframesPreviewRenderer } from '../dist-electron/electron/renderers/hyperframes.js';
import { FfprobeMediaProbe } from '../dist-electron/electron/media/probe.js';
import { exportAss, exportSrt } from '../dist-electron/electron/composition/subtitle-export.js';

const root = path.resolve(import.meta.dirname, '..');
const resources = path.resolve(process.argv[2] || 'resources');
const output = path.resolve(process.argv[3] || '.windows-smoke/preview-export-regression');
await mkdir(output, { recursive: true });
const tools = { ffmpegPath: path.join(resources, 'ffmpeg/ffmpeg.exe'), ffprobePath: path.join(resources, 'ffmpeg/ffprobe.exe'),
  chromePath: path.join(resources, 'browser/chrome-headless-shell-win64/chrome-headless-shell.exe') };
const run = promisify(execFile);
const ff = (...args) => run(tools.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const voice = path.join(output, 'narration.wav'), video = path.join(output, 'source.mp4'), image = path.join(output, 'still.jpg');
await ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ar', '24000', voice);
await ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video);
await ff('-f', 'lavfi', '-i', 'color=c=steelblue:size=640x360', '-frames:v', '1', image);
const draft = createDraftEditPlan({ id: 'regression', script: '第一段。第二段。第三段。', voiceId: 'vivian', sourceVideoPath: video, aspectRatio: '16:9' });
const initial = resolveEditPlan(draft, { sourceMetadata: { durationMs: 6000, hasAudio: true }, narration: {
  audioPath: voice, durationMs: 6000, segments: draft.scenes.map((scene, index) => ({ id: scene.id, text: scene.script, startMs: index * 2000, endMs: (index + 1) * 2000, audioPath: voice }))
} });
initial.canvas.width = 640; initial.canvas.height = 360;
initial.scenes[1].visual = { ...initial.scenes[1].visual, type: 'image', assetId: 'image', sourceInMs: undefined, sourceOutMs: undefined };
initial.scenes[2].visual = { ...initial.scenes[2].visual, type: 'kinetic-text', assetId: undefined, sourceInMs: undefined, sourceOutMs: undefined };
const renderer = new HyperframesPreviewRenderer(id => id === 'image' ? image : video, tools);
const probe = new FfprobeMediaProbe(tools.ffprobePath);
let saved = initial;
let sequence = 0;
const prepared = new Map();
async function prepare(plan) {
  const key = `preview-${++sequence}`;
  const result = await renderer.prepare(plan, path.join(output, key));
  prepared.set(key, result);
  return { plan, preview: { entryUrl: `${origin}/${key}/index.html`, durationMs: result.durationMs, width: plan.canvas.width, height: plan.canvas.height } };
}
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = pathname.startsWith('/preview-') ? path.join(output, pathname) : path.join(root, 'dist', pathname === '/' ? 'index.html' : pathname);
  try {
    const data = await readFile(filename); const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    res.setHeader('Content-Type', contentTypes[path.extname(filename)] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const start = Number(range[1]), end = Math.min(data.length - 1, range[2] ? Number(range[2]) : data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
    } else res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: tools.chromePath, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const checks = [];
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const resumed = await prepare(saved);
  await page.exposeFunction('__updateAudio', async (_id, settings) => {
    saved = EditPlanSchema.parse({ ...saved, bgm: settings.bgm, audio: settings.audio, output: { ...saved.output, playbackRate: settings.playbackRate }, revision: saved.revision + 1 });
    // playbackRate is an output setting, never part of the canonical narration timing.
    return prepare(saved);
  });
  await page.exposeFunction('__generate', async request => {
    saved = EditPlanSchema.parse({ ...saved, input: { ...saved.input, script: request.script }, bgm: request.bgm, audio: request.audio,
      output: { ...saved.output, playbackRate: request.playbackRate }, revision: saved.revision + 1 });
    return prepare(saved);
  });
  await page.evaluateOnNewDocument(initialState => {
    window.__calls = []; let listener;
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: 'ready' }), semanticStatus: async () => ({ configured: false, enginePath: '', modelPath: '' }),
      listVoices: async () => [], listAssets: async () => [{ id: 'source-video', filePath: initialState.plan.input.sourceVideoPath, type: 'video', hasAudio: true }],
      resumeLastProject: async () => initialState, onCompositionProgress: callback => { listener = callback; return () => {}; }, onExportProgress: () => () => {},
      listSceneCandidates: async (id, sceneId, query, throughSceneId) => { window.__calls.push({ candidates: { sceneId, throughSceneId } }); return { query: '', querySource: 'none', candidates: [] }; },
      updateAudio: async (id, settings) => { window.__calls.push({ audio: settings }); return window.__updateAudio(id, settings); },
      generateComposition: async request => { window.__calls.push({ generate: request }); const result = await window.__generate(request);
        setTimeout(() => listener({ jobId: 'generated', phase: 'complete', progress: 1, message: '自动成片预览已就绪', ...result }), 100);
        return { jobId: 'generated', projectId: result.plan.id }; },
      exportArtifact: async (id, kind) => { window.__calls.push({ artifact: kind }); return null; }, exportVideo: async () => { window.__calls.push({ mp4: true }); return null; }
    };
  }, resumed);
  await page.goto(origin); await page.waitForFunction(() => document.querySelector('hyperframes-player')?.ready);
  await page.click('.more-toggle');
  assert.equal(await page.$$eval('button', els => els.some(el => el.textContent.includes('应用音轨并试听'))), false);
  await page.$$eval('.bgm-controls label', labels => labels.find(label => label.textContent.includes('保留原视频声音')).querySelector('input').click());
  await page.click('.generate-button');
  await page.waitForFunction(() => window.__calls.some(call => call.audio?.audio.originalEnabled));
  await page.waitForFunction(() => !document.querySelector('.generate-button').disabled && document.querySelector('hyperframes-player')?.ready);
  assert.equal(saved.audio.originalEnabled, true);
  // Force a complete new generation, which previously lost the selected original-audio option.
  await page.$eval('.script-field textarea', textarea => { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, textarea.value + '再来一句。'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.generate-button');
  await page.waitForFunction(() => window.__calls.some(call => call.generate));
  await page.waitForFunction(() => !document.querySelector('.generate-button').disabled && document.querySelector('hyperframes-player')?.ready);
  assert.equal(saved.audio.originalEnabled, true);
  assert.equal(await page.$eval('.job-status', el => el.closest('.preview-pane') !== null), true);
  const canonicalScenes = structuredClone(saved.scenes);
  for (const rate of [2, 4, .5, 1]) {
    await page.select('.preview-speed select', String(rate));
    await page.waitForFunction(rate => !document.querySelector('.generate-button').disabled && document.querySelector('hyperframes-player')?.ready && Number(document.querySelector('.preview-speed select').value) === rate, {}, rate);
    assert.deepEqual(saved.scenes, canonicalScenes, 'changing speed modified scene structure or source offsets');
    const labels = await page.$$eval('.scene-card small', elements => elements.map(element => element.textContent));
    assert.ok(labels[0].includes(`成片 0.0–${(2 / rate).toFixed(1)} 秒`));
    assert.ok(labels[0].includes('原视频 0.0–2.0 秒'), 'source timestamps must stay in the source clock');
    assert.ok(labels[2].includes(`成片 ${(4 / rate).toFixed(1)}–${(6 / rate).toFixed(1)} 秒`));
    await page.click('.scene-card button');
    await page.waitForSelector('.candidate-scope');
    assert.ok(await page.$eval('.candidate-scope option', (element, rate) => element.textContent.includes(`成片 ${(2 / rate).toFixed(1)} 秒`), rate));
    await page.select('.candidate-scope select', saved.scenes[2].id);
    await page.waitForFunction(id => window.__calls.some(call => call.candidates?.throughSceneId === id), {}, saved.scenes[2].id);
    await page.waitForFunction(rate => [...document.querySelectorAll('.candidate-message')].some(element => element.textContent.includes(`覆盖成片 ${(6 / rate).toFixed(1)} 秒`)), {}, rate);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { const player = document.querySelector('hyperframes-player'); player.seek(0); player.play(); });
    await new Promise(resolve => setTimeout(resolve, 250));
    const first = await page.evaluate(() => document.querySelector('hyperframes-player').currentTime);
    assert.ok(first > .1, `preview did not advance at ${rate}x: ${first}`);
    const frame = page.frames().find(frame => frame.url().includes('/preview-'));
    const state = await frame.evaluate(() => ({ videoTime: document.querySelector('video').currentTime,
      videoRate: document.querySelector('video').playbackRate, visible: getComputedStyle(document.querySelector('video')).visibility,
      audioTime: document.querySelector('audio').currentTime, audioPaused: document.querySelector('audio').paused,
      error: document.querySelector('video').error?.message }));
    assert.equal(state.error, undefined); assert.equal(state.visible, 'visible'); assert.ok(state.videoTime > .04);
    assert.equal(state.videoRate, rate); assert.equal(state.audioPaused, false);
    assert.ok(Math.abs(state.videoTime / rate - state.audioTime) < .12, `audio/video clock drift at ${rate}x: ${JSON.stringify(state)}`);
    await page.evaluate(() => { const player = document.querySelector('hyperframes-player'); player.pause(); player.seek(0); player.play(); });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(await page.evaluate(() => document.querySelector('hyperframes-player').currentTime) > .05, `replay stuck at ${rate}x`);
    await page.evaluate(() => document.querySelector('hyperframes-player').pause());
    for (const fraction of [.25, .55, .85]) {
      await page.evaluate(fraction => { const player = document.querySelector('hyperframes-player'); player.seek(player.duration * fraction); player.play(); }, fraction);
      await new Promise(resolve => setTimeout(resolve, 150));
      const painted = await frame.evaluate(() => [...document.querySelectorAll('.visual,.kinetic')].some(element => {
        const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > .01;
      }));
      assert.ok(painted, `preview became blank at ${rate}x, fraction ${fraction}`);
      await page.evaluate(() => document.querySelector('hyperframes-player').pause());
    }
    await page.evaluate(() => { const player = document.querySelector('hyperframes-player'); player.seek(player.duration); player.play(); });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(await page.evaluate(() => document.querySelector('hyperframes-player').currentTime) < .8, 'play at end failed to restart');
    await page.evaluate(() => document.querySelector('hyperframes-player').pause());
    const composition = prepared.get(`preview-${sequence}`);
    const outputPath = path.join(output, `export-${rate}x.mp4`);
    await renderer.render({ jobId: randomUUID(), composition, outputPath }, () => {});
    const info = await probe.probe(outputPath);
    assert.ok(Math.abs(info.durationMs - 6000 / rate) < 160, `wrong export duration at ${rate}x: ${info.durationMs}`);
    // Read actual source frame at 0.4 output seconds; source time must be multiplied by speed.
    const { stdout: actual } = await run(tools.ffmpegPath, ['-v', 'error', '-ss', '0.4', '-i', outputPath, '-frames:v', '1', '-vf', 'crop=120:80:20:20', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    assert.ok(actual.some(value => value > 110), 'exported video is black');
    const mixed = path.join(composition.workspace, 'mixed.wav');
    const mp3 = path.join(output, `mixed-${rate}x.mp3`); await ff('-i', mixed, '-c:a', 'libmp3lame', mp3);
    assert.ok(Math.abs((await probe.probe(mp3)).durationMs - 6000 / rate) < 160);
    await writeFile(path.join(output, `captions-${rate}x.srt`), exportSrt(saved));
    await writeFile(path.join(output, `captions-${rate}x.ass`), exportAss(saved));
    checks.push({ rate, previewTime: first, ...state, durationMs: info.durationMs });
  }
  for (const label of ['导出旁白 MP3', '导出混音 MP3', '导出 SRT', '导出 ASS']) await page.$$eval('button', (buttons, label) => buttons.find(button => button.textContent === label).click(), label);
  await page.waitForFunction(() => window.__calls.filter(call => call.artifact).length === 4);
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call.artifact).map(call => call.artifact)), ['narration-mp3', 'mixed-mp3', 'srt', 'ass']);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'preview-controls.png') });
  const kineticDraft = createDraftEditPlan({ id: 'first-kinetic', script: '你好。', voiceId: 'vivian', aspectRatio: '16:9' });
  const kinetic = resolveEditPlan(kineticDraft, { narration: { audioPath: voice, durationMs: 720,
    segments: [{ id: 'scene-001', text: '你好。', startMs: 0, endMs: 720, audioPath: voice }] } });
  kinetic.canvas.width = 640; kinetic.canvas.height = 360;
  const kineticPage = await browser.newPage();
  await kineticPage.goto(origin);
  await kineticPage.waitForFunction(() => customElements.get('hyperframes-player'));
  for (const rate of [.5, 2, 4, 1]) {
    const result = await prepare(EditPlanSchema.parse({ ...kinetic, output: { ...kinetic.output, playbackRate: rate } }));
    await kineticPage.evaluate(preview => {
      const player = document.createElement('hyperframes-player'); player.setAttribute('src', preview.entryUrl);
      player.style.width = '640px'; player.style.height = '360px';
      player.setAttribute('width', preview.width); player.setAttribute('height', preview.height);
      document.body.replaceChildren(player);
    }, result.preview);
    await kineticPage.waitForFunction(() => document.querySelector('hyperframes-player')?.ready);
    const duration = await kineticPage.evaluate(() => document.querySelector('hyperframes-player').duration);
    assert.ok(Math.abs(duration - .72 / rate) < .04, `short preview duration mismatch: ${duration} at ${rate}x`);
    const frame = kineticPage.frames().find(frame => frame.url().includes('/preview-'));
    for (let replay = 0; replay < 2; replay++) {
      await kineticPage.evaluate(() => { const player = document.querySelector('hyperframes-player'); player.seek(0); player.play(); });
      await new Promise(resolve => setTimeout(resolve, 50));
      await kineticPage.evaluate(() => document.querySelector('hyperframes-player').pause());
      const visible = await frame.evaluate(() => getComputedStyle(document.querySelector('.kinetic')).visibility === 'visible' && Number(getComputedStyle(document.querySelector('.kinetic')).opacity) > .9);
      assert.ok(visible, `first kinetic frame disappeared at ${rate}x, replay ${replay}`);
    }
  }
  await kineticPage.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, checks, originalAudioPreserved: true, unifiedGenerate: true, storyboardTimesScaled: true, sourceOffsetsPreserved: true }, null, 2));
  console.log('Preview/export regression passed', checks);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
