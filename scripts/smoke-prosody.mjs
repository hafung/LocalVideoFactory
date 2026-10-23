import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
const root = path.resolve(import.meta.dirname, '..');
const resources = path.resolve(option('--resources', path.join(root, 'resources')));
const output = path.resolve(option('--output', path.join(root, 'prosody-check')));
const load = file => import(pathToFileURL(path.join(root, 'dist-electron', file)).href);
const { QwenEngine } = await load('electron/engine.js');
const { NarrationService } = await load('electron/composition/narration.js');
const { QwenNarrationSynthesizer } = await load('electron/composition/qwen-narration.js');
const { WavMediaProbe } = await load('electron/media/probe.js');
const { createDraftEditPlan, EditPlanSchema } = await load('shared/edit-plan.js');
const { describeTtsModel } = await load('electron/tts-model.js');
const { alignNarration, senseVoiceNarrationTranscriber } = await load('electron/alignment/narration.js');
const { resolveEditPlan } = await load('electron/composition/resolver.js');
await mkdir(output, { recursive: true });
const script = option('--text', '你以为，事情就这样结束了？其实，真正的转机才刚刚开始。\n终于，我们做到了！这份喜悦，值得好好记住。');
const enginePath = path.join(resources, 'engine', 'qwen_tts.exe');
const probe = new WavMediaProbe();
const models = ['qwen3-tts-1.7b-customvoice'];
const measurements = [];
for (const name of models) {
  const modelDir = path.join(resources, 'models', name);
  const engine = new QwenEngine({ enginePath, modelDir });
  const file = path.join(output, `${name}-raw.wav`);
  const start = performance.now();
  await engine.synthesize({ text: script.replaceAll('\n', ' '), outputPath: file, outputFormat: 'wav', language: 'Chinese',
    speaker: 'vivian', temperature: .5, topK: 50, topP: 1, seed: 42, threads: 4, precision: 'int8', automaticProsody: false }, () => undefined);
  const wallMs = Math.round(performance.now() - start);
  const { durationMs } = await probe.probe(file);
  const measurement = { name, mode: 'raw', wallMs, durationMs, rtf: Number((wallMs / durationMs).toFixed(3)), file };
  measurements.push(measurement);
  console.log(JSON.stringify(measurement));
}
const modelDir = path.join(resources, 'models', models[0]);
const engine = new QwenEngine({ enginePath, modelDir });
const model = await describeTtsModel(modelDir);
const plan = createDraftEditPlan({ id: 'automatic-prosody-smoke', script, voiceId: 'vivian' });
const warnings = [];
const start = performance.now();
// Each measurement must synthesize afresh, including after a failed prior run.
const cacheDir = await mkdtemp(path.join(output, '.cache-'));
let narration;
try {
  narration = await new NarrationService({ cacheDir, synthesizer: new QwenNarrationSynthesizer(engine),
    probe, voice: { language: 'Chinese', temperature: .5, topK: 50, topP: 1, seed: 42, precision: 'int8',
      engineVersion: 'qwen3-tts-c-v0.2.1', modelVersion: model.identity }
  }).generate(plan, path.join(output, 'automatic'), undefined, event => console.log(event.message));
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
const wallMs = Math.round(performance.now() - start);
const aligned = await alignNarration(narration, plan.scenes, senseVoiceNarrationTranscriber(path.join(resources, 'models', 'sensevoice-small')),
  undefined, message => warnings.push(message));
const resolved = EditPlanSchema.parse(resolveEditPlan(plan, { narration: aligned }));
const tokens = resolved.captions.flatMap(cue => cue.tokens);
const expected = script.replace(/[\p{P}\p{S}\s]/gu, '');
if (tokens.map(token => token.text).join('') !== expected) throw new Error('Caption text changed during automatic prosody processing.');
if (!tokens.length || tokens.filter(token => token.source === 'aligned').length / tokens.length < .8) {
  throw new Error(`Acoustic alignment did not cover enough text: ${warnings.join('; ')}`);
}
for (const segment of narration.segments) {
  if (tokens.some(token => token.startMs >= segment.speechEndMs && token.startMs < segment.endMs)) {
    throw new Error('A caption starts inside the inserted paragraph pause.');
  }
}
const automatic = { name: models[0], mode: 'automatic', wallMs, durationMs: narration.durationMs,
  rtf: Number((wallMs / narration.durationMs).toFixed(3)), file: narration.audioPath };
measurements.push(automatic);
const report = { ok: true, cpu: os.cpus()[0]?.model, precision: 'int8', threads: 4, seed: 42,
  modelRevision: model.identity, script, measurements, synthesisGroups: narration.segments.length,
  sceneCount: resolved.scenes.length, alignedTokens: tokens.filter(token => token.source === 'aligned').length,
  tokenCount: tokens.length, warnings, narration: resolved.narration, captions: resolved.captions };
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, 'edit-plan.json'), `${JSON.stringify(resolved, null, 2)}\n`);
console.log(JSON.stringify({ ...automatic, ok: true, alignedTokens: report.alignedTokens, tokenCount: report.tokenCount, warnings }));
