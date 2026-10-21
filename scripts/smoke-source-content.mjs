import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDraftEditPlan } from '../dist-electron/shared/edit-plan.js';
import { LocalLlamaScenePlanner } from '../dist-electron/electron/composition/scene-planner.js';
import { resolveSceneModelPaths } from '../dist-electron/electron/composition/scene-model.js';
import { analyzeSourceContent, matchSourceContent } from '../dist-electron/electron/composition/source-content.js';
import { resolveEditPlan } from '../dist-electron/electron/composition/resolver.js';
import { alignWithSenseVoiceProcess } from '../dist-electron/electron/alignment/sensevoice-process.js';

const run = promisify(execFile);
const resources = path.join(process.cwd(), 'resources');
const config = resolveSceneModelPaths(resources, resources);
assert.ok(config.modelPath && config.projectorPath, 'Install bundled text and vision GGUF resources first.');
const workspace = path.join(process.cwd(), '.windows-smoke', 'source-content');
await mkdir(workspace, { recursive: true });
const ffmpeg = path.join(resources, 'ffmpeg', 'ffmpeg.exe');
const file = path.join(workspace, 'red-blue.mp4');
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=12:d=4,drawbox=x=100:y=40:w=120:h=100:color=red:t=fill',
  '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=12:d=4,drawbox=x=100:y=40:w=120:h=100:color=blue:t=fill', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
const planner = new LocalLlamaScenePlanner(() => config);
const cacheDir = path.join(workspace, `cache-${Date.now()}`);
const requestJson = planner.json.bind(planner);
planner.json = async (...args) => { const result = await requestJson(...args); console.log('Native model JSON:', JSON.stringify(result)); return result; };
const began = Date.now(); const signal = AbortSignal.timeout(600_000);
let report;
try {
  const index = await analyzeSourceContent({ file, metadata: { durationMs: 8000, hasAudio: false },
    ranges: [{ startMs: 0, endMs: 4000 }, { startMs: 4000, endMs: 8000 }], ffmpeg,
    cacheDir, modelIdentity: 'native-review-v1', model: planner,
    transcribe: async () => { throw new Error('Silent video must not invoke ASR'); }, signal, progress: console.log });
  assert.equal(index.warnings.length, 0, index.warnings.join('\n'));
  assert.ok(index.candidates.length >= 2 && index.candidates.every(candidate => candidate.vision));
  console.log('Vision descriptions:', JSON.stringify(index.candidates));
  const draft = createDraftEditPlan({ id: 'native-content', script: '白色背景中央有一个蓝色方块。', voiceId: 'vivian', sourceVideoPath: file });
  const content = await matchSourceContent(draft, index, planner, signal, console.log);
  console.log('Semantic matches:', JSON.stringify(content.matches));
  assert.equal(content.index.warnings.length, 0, content.index.warnings.join('\n'));
  const resolved = resolveEditPlan(draft, { sourceMetadata: { durationMs: 8000, hasAudio: false }, sourceContent: content,
    narration: { audioPath: '/unused-voice.wav', durationMs: 2000, segments: [{ id: draft.scenes[0].id,
      text: draft.input.script, startMs: 0, endMs: 2000 }] } });
  assert.equal(resolved.scenes[0].visual.type, 'source');
  assert.ok(resolved.scenes[0].visual.sourceInMs >= 4000, 'Blue narration must select the later blue clip.');
  let cacheObserved = false;
  const cached = await analyzeSourceContent({ file, metadata: { durationMs: 8000, hasAudio: false },
    ranges: [{ startMs: 0, endMs: 4000 }, { startMs: 4000, endMs: 8000 }], ffmpeg, cacheDir,
    modelIdentity: 'native-review-v1', model: { enableVision() { throw new Error('Cached analysis must not invoke inference'); } },
    transcribe: async () => { throw new Error('Cached analysis must not invoke ASR'); }, signal,
    progress: message => { cacheObserved ||= message.includes('缓存'); } });
  assert.ok(cacheObserved); assert.deepEqual(cached, index);
  report = { visionElapsedMs: Date.now() - began, index, matches: content.matches, scenes: resolved.scenes };
} finally { planner.dispose(); }
// Use an optional real speech recording to exercise the exact isolated source-ASR worker.
const speechIndex = process.argv.indexOf('--speech');
if (speechIndex >= 0) {
  const speech = path.resolve(process.argv[speechIndex + 1]); const wav = path.join(workspace, 'speech-16k.wav');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', speech, '-vn', '-ar', '16000', '-ac', '1', wav], { windowsHide: true });
  const executable = process.platform === 'win32' ? createRequire(import.meta.url)('electron') : process.execPath;
  const recognized = await alignWithSenseVoiceProcess(path.join(resources, 'models', 'sensevoice-small'), wav, executable, undefined, signal, true);
  assert.ok(recognized.tokens.length && recognized.speechSegments?.length, 'Real source speech must return transcript and VAD ranges.');
  report.speech = recognized;
}
await writeFile(path.join(workspace, 'result.json'), JSON.stringify({ ok: true, ...report }, null, 2));
console.log(JSON.stringify({ ok: true, visionElapsedMs: report.visionElapsedMs, descriptions: report.index.candidates.map(item => item.description),
  selectedSourceInMs: report.scenes[0].visual.sourceInMs, speechTokens: report.speech?.tokens.length }, null, 2));
