// Real FFmpeg -> ASR -> cut audio -> Hyperframes preview/export. No TTS required.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { TalkProjectSchema, talkDuration } from '../dist-electron/shared/talking-head.js';
import { importTalkVideo, analyzeTalkVideo, prepareTalkAudio, prepareTalkVoiceAudition } from '../dist-electron/electron/talking-head/media.js';
import { talkCues, pauseCuts, fillerSuggestions, updateTalkProject } from '../dist-electron/electron/talking-head/editing.js';
import { talkOutputCaptions, talkSrt, talkAss } from '../dist-electron/electron/talking-head/captions.js';
import { compileTalkTemplate } from '../dist-electron/electron/talking-head/compiler.js';
import { HyperframesPreviewRenderer } from '../dist-electron/electron/renderers/hyperframes.js';
import { FfprobeMediaProbe } from '../dist-electron/electron/media/probe.js';

const run = promisify(execFile), root = path.resolve('.windows-smoke/talking-head');
const tools = { ffmpegPath: process.env.VOXWEAVE_FFMPEG, ffprobePath: process.env.VOXWEAVE_FFPROBE,
  senseVoiceRoot: path.resolve('resources/models/sensevoice-small') };
if (!tools.ffmpegPath || !tools.ffprobePath || !process.env.VOXWEAVE_CHROME)
  throw new Error('Set VOXWEAVE_FFMPEG, VOXWEAVE_FFPROBE and VOXWEAVE_CHROME');
await mkdir(root, { recursive: true });
const input = path.join(root, 'input.mp4');
const speech = path.resolve(process.env.VOXWEAVE_TALK_SMOKE_SPEECH || 'docs/demos/funny-demo.mp4');
// Keep real speech before and after a 2.5-second silence, and a moving source to check cuts.
await run(tools.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-i', speech, '-filter_complex', '[1:a]atrim=0:2,asetpts=PTS-STARTPTS[a];anullsrc=r=48000:cl=mono,atrim=duration=2.5[s];[1:a]atrim=start=2:end=4,asetpts=PTS-STARTPTS[b];[a][s][b]concat=n=3:v=0:a=1[voice]',
  '-map', '0:v:0', '-map', '[voice]', '-t', '6.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', input], { maxBuffer: 4 * 1024 * 1024 });
const directory = path.join(root, 'project');
// A rerun may use a different sample. Discard only this script's derived fixtures.
await Promise.all([directory, path.join(root, 'preview')].map(directory => rm(directory, { recursive: true, force: true })));
const source = await importTalkVideo(input, directory, tools);
const analysis = await analyzeTalkVideo(directory, source.durationMs, tools, new AbortController().signal,
  (_, message) => process.stdout.write(`${message}\n`));
assert.ok(analysis.tokens.length > 0, 'Real ASR must return speech');
assert.ok(analysis.speech.length > 0);
assert.ok(analysis.silence.some(range => range.endMs - range.startMs > 1800));
const now = new Date().toISOString();
let project = TalkProjectSchema.parse({ schemaVersion: 1, mode: 'talking-head',
  id: '047bc12c-d946-4748-921d-59f8fd65a131', revision: 1, createdAt: now, updatedAt: now,
  source, strength: 'natural', captions: { enabled: true, reveal: 'character', highlight: 'color', position: 'bottom' },
  cues: talkCues(analysis.tokens), cuts: [], speech: analysis.speech, silence: analysis.silence,
  overlays: [], audio: { voiceVolume: 1, bgmVolume: .12, ducking: true }, warnings: [] });
project.cuts = [...pauseCuts(project), ...fillerSuggestions(analysis.tokens, source.durationMs)];
assert.ok(project.cuts.some(cut => cut.kind === 'pause' && cut.applied), 'A proven long silent pause must be shortened');
assert.ok(talkDuration(project) < source.durationMs - 800);
const before = JSON.stringify(project.cuts), tokensBefore = JSON.stringify(project.cues.map(cue => cue.tokens));
project = updateTalkProject(project, { revision: project.revision,
  edits: [{ cueId: project.cues[0].id, text: '声织|测试字幕。' }],
  overlays: [{ id: 'sketch', cueId: project.cues[0].id, type: 'whiteboard', text: '保留原声\n自然节奏', layout: 'pip', position: 'top-right', sourceInMs: 0, enabled: true }] });
assert.equal(JSON.stringify(project.cuts), before);
assert.equal(JSON.stringify(project.cues.map(cue => cue.tokens)), tokensBefore);
const audio = await prepareTalkAudio(project, directory, tools, () => { throw new Error('No BGM'); });
const probe = new FfprobeMediaProbe(tools.ffprobePath);
const audioInfo = await probe.probe(audio);
assert.ok(Math.abs(audioInfo.durationMs - talkDuration(project)) <= 1);
const enhancedProject = updateTalkProject(project, {
  revision: project.revision, audio: { ...project.audio, voiceEnhancement: 'warm' }
});
const enhancedAudio = await prepareTalkAudio(enhancedProject, directory, tools, () => { throw new Error('No BGM'); });
assert.notEqual(enhancedAudio, audio);
assert.notDeepEqual(await readFile(enhancedAudio), await readFile(audio));
assert.equal((await probe.probe(enhancedAudio)).durationMs, audioInfo.durationMs);
assert.equal(talkSrt(enhancedProject), talkSrt(project));
assert.equal(talkAss(enhancedProject), talkAss(project));
for (const preset of ['natural', 'clear', 'warm']) {
  const samples = await prepareTalkVoiceAudition(project, directory, tools.ffmpegPath, { preset, atMs: 0 });
  assert.equal(samples.original.byteLength, samples.enhanced.byteLength);
  assert.notDeepEqual(new Uint8Array(samples.original), new Uint8Array(samples.enhanced));
}
assert.equal(await prepareTalkAudio(project, directory, tools, () => { throw new Error('No BGM'); }), audio);
const resolveAsset = () => { throw new Error('No library assets'); };
const workspace = path.join(root, 'preview');
const prepared = await compileTalkTemplate(enhancedProject, directory, workspace, enhancedAudio, resolveAsset);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    const info = await stat(file), range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/u);
    const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mp4': 'video/mp4', '.wav': 'audio/wav' }[path.extname(file)] || 'application/octet-stream';
    const data = await readFile(file);
    if (range) {
      const from = Number(range[1]), to = range[2] ? Number(range[2]) : info.size - 1;
      response.writeHead(206, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${from}-${to}/${info.size}`, 'Content-Length': to - from + 1 });
      response.end(data.subarray(from, to + 1));
    } else { response.writeHead(200, { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' }); response.end(data); }
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage(); await page.setViewport({ width: source.width, height: source.height });
  await page.goto(`${base}/preview/index.html`);
  await page.waitForFunction(() => !!window.__timelines?.['talk-captions']);
  const cue = talkOutputCaptions(project)[0], first = cue.characters[0], middle = cue.characters[Math.min(2, cue.characters.length - 1)];
  async function seek(time) {
    return page.evaluate(time => {
      for (const timeline of Object.values(window.__timelines)) timeline.seek(time / 1000);
      return [...document.querySelectorAll('.caption')].filter(element => getComputedStyle(element).visibility === 'visible').map(element => ({
        full: element.textContent,
        visible: [...element.querySelectorAll('span')].filter(span => getComputedStyle(span).visibility !== 'hidden').map(span => span.textContent).join('')
      }));
    }, time);
  }
  const initial = await seek(first.startMs + 1), later = await seek(middle.startMs + 1);
  assert.ok(initial.length > 0 && later.length > 0, 'Subtitles should be visible');
  assert.ok(later[0].visible.length >= initial[0].visible.length, 'Progressive text should accumulate');
  assert.ok(initial[0].visible.length < initial[0].full.length, 'Unspoken text must be hidden');
  await page.screenshot({ path: path.join(root, 'progressive-caption.png') });
  await writeFile(path.join(root, 'subtitles.srt'), talkSrt(project));
  await writeFile(path.join(root, 'subtitles.ass'), talkAss(project));
  if (process.argv.includes('--render')) {
    const renderer = new HyperframesPreviewRenderer(undefined, { ...tools, chromePath: process.env.VOXWEAVE_CHROME });
    await renderer.render({ jobId: 'talk-smoke', composition: prepared, outputPath: path.join(root, 'output.mp4') }, event => {
      if (event.phase === 'complete') process.stdout.write(`${event.message}\n`);
    });
    const rendered = await probe.probe(path.join(root, 'output.mp4'));
    assert.ok(rendered.hasAudio && rendered.videoCodec === 'h264' && rendered.audioCodec === 'aac');
    assert.ok(Math.abs(rendered.durationMs - prepared.durationMs) < 250);
  }
  await writeFile(path.join(root, 'project.json'), JSON.stringify(project, null, 2));
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ ok: true, sourceMs: source.durationMs, outputMs: prepared.durationMs,
    recognizedTokens: analysis.tokens.length, cuts: project.cuts, initial, later, audioInfo }, null, 2));
  process.stdout.write(`Talking-head smoke passed: ${source.durationMs} -> ${prepared.durationMs} ms, ${analysis.tokens.length} ASR tokens, voice presets and export.\n`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
