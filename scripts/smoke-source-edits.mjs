import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDraftEditPlan } from '../dist-electron/shared/edit-plan.js';
import { resolveEditPlan } from '../dist-electron/electron/composition/resolver.js';
import { analyzeSource } from '../dist-electron/electron/composition/source-edits.js';
import { HyperframesPreviewRenderer } from '../dist-electron/electron/renderers/hyperframes.js';
import { FfprobeMediaProbe } from '../dist-electron/electron/media/probe.js';

const run = promisify(execFile);
const root = process.cwd();
const workspace = path.join(root, '.windows-smoke', 'source-edits'); await mkdir(workspace, { recursive: true });
const ffmpeg = process.env.VOXWEAVE_FFMPEG || path.join(root, 'resources/ffmpeg/ffmpeg.exe');
const ffprobe = process.env.VOXWEAVE_FFPROBE || path.join(root, 'resources/ffmpeg/ffprobe.exe');
const source = path.join(workspace, 'red-black-blue.mp4');
await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=red:s=160x284:r=24:d=4',
  '-f', 'lavfi', '-i', 'color=c=black:s=160x284:r=24:d=1',
  '-f', 'lavfi', '-i', 'color=c=blue:s=160x284:r=24:d=4',
  '-f', 'lavfi', '-i', 'sine=frequency=200:sample_rate=48000:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000:duration=1',
  '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000:duration=4',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];[3:a][4:a][5:a]concat=n=3:v=0:a=1[a]',
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { windowsHide: true });
const probe = new FfprobeMediaProbe(ffprobe); const metadata = await probe.probe(source);
const analysis = await analyzeSource(source, metadata.durationMs, ffmpeg);
assert.equal(analysis.warning, undefined);
const usable = analysis.ranges.reduce((sum, range) => sum + range.endMs - range.startMs, 0);
assert.ok(usable >= 7500 && usable <= 8250, JSON.stringify(analysis));

function frequencyPower(pcm, frequency, from, to) {
  let real = 0, imaginary = 0; const rate = 8000;
  for (let index = Math.round(from * rate); index < Math.round(to * rate); index++) {
    const value = pcm.readFloatLE(index * 4); const phase = 2 * Math.PI * frequency * index / rate;
    real += value * Math.cos(phase); imaginary += value * Math.sin(phase);
  }
  return real * real + imaginary * imaginary;
}
const results = [];
for (const durationMs of [4000, 12000]) {
  const narrationFile = path.join(workspace, `voice-${durationMs}.wav`);
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(durationMs / 1000), narrationFile]);
  const draft = createDraftEditPlan({ id: `source-${durationMs}`, script: '开头画面。结尾画面。', voiceId: 'vivian', sourceVideoPath: source });
  draft.audio = { ...draft.audio, originalEnabled: true, narrationVolume: 0, originalVolume: 1, originalDucking: false };
  const plan = resolveEditPlan(draft, { sourceMetadata: metadata, sourceRanges: analysis.ranges,
    narration: { audioPath: narrationFile, durationMs, segments: draft.scenes.map((scene, index) => ({
      id: scene.id, text: scene.script, startMs: index * durationMs / 2, endMs: (index + 1) * durationMs / 2 })) } });
  plan.canvas = { ...plan.canvas, width: 160, height: 284, fps: 24 };
  plan.captions = [];
  const output = path.join(workspace, String(durationMs));
  const renderer = new HyperframesPreviewRenderer(() => source, { ffmpegPath: ffmpeg, ffprobePath: ffprobe,
    chromePath: path.join(root, 'resources/browser/chrome-headless-shell-win64/chrome-headless-shell.exe') });
  const preview = await renderer.prepare(plan, output);
  await writeFile(path.join(output, 'edit-plan.json'), JSON.stringify(plan, null, 2));
  assert.equal(preview.durationMs, durationMs);
  const mixed = path.join(output, 'mixed.wav'); const mixedMetadata = await probe.probe(mixed);
  assert.ok(Math.abs(mixedMetadata.durationMs - durationMs) < 5);
  const { stdout: pcm } = await run(ffmpeg, ['-v', 'error', '-i', mixed, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
  assert.ok(frequencyPower(pcm, 200, .5, 1.5) > frequencyPower(pcm, 800, .5, 1.5) * 100);
  const second = durationMs === 4000 ? 2.5 : 5.5;
  assert.ok(frequencyPower(pcm, 800, second, second + 1) > frequencyPower(pcm, 200, second, second + 1) * 100);
  if (durationMs === 12000) {
    let rms = 0; for (let index = 10 * 8000; index < 11 * 8000; index++) rms += pcm.readFloatLE(index * 4) ** 2;
    assert.ok(rms / 8000 < 1e-8, 'original audio must not loop into supplemental media');
  }
  if (durationMs === 4000 && process.argv.includes('--render')) {
    const mp4 = path.join(output, 'source-montage.mp4');
    await renderer.render({ jobId: 'source-montage-smoke', composition: preview, outputPath: mp4 }, () => {});
    const pixels = [];
    for (const seek of [.5, 2.5]) {
      const { stdout } = await run(ffmpeg, ['-v', 'error', '-ss', String(seek), '-i', mp4, '-frames:v', '1',
        '-vf', 'crop=32:32:64:32,scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
      pixels.push([...stdout]);
    }
    assert.ok(pixels[0][0] > pixels[0][2] * 2 && pixels[1][2] > pixels[1][0] * 2,
      `Export must include red opening and blue ending, not the black middle: ${JSON.stringify(pixels)}`);
  }
  results.push({ durationMs, sourceRanges: plan.audio.originalSegments, types: plan.scenes.map(scene => scene.visual.type) });
}
await writeFile(path.join(workspace, 'result.json'), JSON.stringify({ analysis, results }, null, 2));
console.log('Source edit smoke passed: black exclusion, full-source montage, exact preview duration, selected original audio, silence after original ends.');
