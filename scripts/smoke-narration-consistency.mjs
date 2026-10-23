import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = path.resolve(import.meta.dirname, '..');
const load = file => import(pathToFileURL(path.join(root, 'dist-electron', file)).href);
const { QwenEngine } = await load('electron/engine.js');
const { NarrationService } = await load('electron/composition/narration.js');
const { QwenNarrationSynthesizer } = await load('electron/composition/qwen-narration.js');
const { WavMediaProbe } = await load('electron/media/probe.js');
const { createDraftEditPlan } = await load('shared/edit-plan.js');
const { DEFAULT_NARRATION_SEED, spokenCharacterCount } = await load('shared/prosody.js');
const { alignNarration, senseVoiceNarrationTranscriber } = await load('electron/alignment/narration.js');
const { describeTtsModel } = await load('electron/tts-model.js');
const resources = path.resolve(option('--resources', path.join(root, 'resources')));
const output = path.resolve(option('--output', path.join(root, '.windows-smoke', 'narration-consistency')));
const textFile = option('--text-file');
const script = textFile ? await readFile(textFile, 'utf8')
  : '事情就这样结束了？其实，转机才刚刚开始。我们会把每一个细节讲清楚。\n终于，我们做到了！接下来，继续一步一步向前走。';
const voices = option('--voices', 'vivian,serena').split(',');
const modes = option('--modes', 'before,after').split(',');
assert.ok(modes.length && modes.every(mode => ['before', 'after'].includes(mode)), 'Expected --modes before,after');
const modelDir = path.join(resources, 'models', 'qwen3-tts-1.7b-customvoice');
const model = await describeTtsModel(modelDir);
const probe = new WavMediaProbe();
const engine = new QwenEngine({ enginePath: path.join(resources, 'engine', 'qwen_tts.exe'), modelDir });
// Keep the seed identical in both modes to isolate the instruction and chunking
// changes. The previous desktop path left it unspecified (time-based).
const beforeInstruction = 'Read the text naturally and expressively. Let its meaning guide your emotion, emphasis, speaking pace, and pauses. Keep the expression appropriate and restrained, with clear pronunciation. Read every word as written; do not add words or read these instructions aloud.';
await mkdir(output, { recursive: true });
const measurements = [];
for (const voiceId of voices) {
  for (const mode of modes) {
    const workspace = path.join(output, voiceId, mode);
    const cacheDir = await mkdtemp(path.join(output, '.cache-'));
    // Previously every newline started a separate engine process. Blank lines
    // reproduce that grouping with the current planner, including its pauses.
    const plan = createDraftEditPlan({ id: `${voiceId}-${mode}`, voiceId,
      script: mode === 'before' ? script.replace(/\r?\n+/gu, '\n\n') : script });
    const voice = { language: 'Chinese', temperature: .5, topK: 50, topP: 1,
      seed: DEFAULT_NARRATION_SEED, precision: 'int8', engineVersion: 'qwen3-tts-c-v0.2.1',
      modelVersion: model.identity, instruct: mode === 'before' ? beforeInstruction
        : option('--instruct') === 'none' ? undefined : option('--instruct') };
    const start = performance.now();
    let narration;
    try {
      narration = await new NarrationService({ cacheDir, probe, voice,
        synthesizer: new QwenNarrationSynthesizer(engine) }).generate(plan, workspace, undefined,
        event => console.log(`${voiceId}/${mode}: ${event.message}`));
    } finally { await rm(cacheDir, { recursive: true, force: true }); }
    const synthesisMs = Math.round(performance.now() - start);
    const warnings = [];
    const aligned = await alignNarration(narration, plan.scenes,
      senseVoiceNarrationTranscriber(path.join(resources, 'models', 'sensevoice-small')),
      undefined, message => warnings.push(message));
    const tokens = aligned.captions.flatMap(cue => cue.tokens);
    assert.equal(tokens.map(token => token.text).join(''), script.replace(/[\p{P}\p{S}\s]/gu, ''));
    const alignedRatio = tokens.filter(token => token.source === 'aligned').length / Math.max(1, tokens.length);
    const scenes = plan.scenes.map(scene => {
      const timing = aligned.sceneTimings.find(item => item.id === scene.id);
      return { text: scene.script, ...timing,
        charactersPerSecond: timing ? Number((spokenCharacterCount(scene.script) * 1000 / (timing.endMs - timing.startMs)).toFixed(2)) : undefined };
    });
    const measurement = { voiceId, mode, seed: voice.seed, instruct: voice.instruct,
      synthesisMs, durationMs: narration.durationMs, synthesisGroups: narration.segments.length,
      audioPath: narration.audioPath, alignedRatio, warnings, scenes };
    measurements.push(measurement);
    await writeFile(path.join(workspace, 'report.json'), JSON.stringify({ ...measurement, narration: aligned }, null, 2));
    // Save each result before assertions so failed recognition remains inspectable.
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ script, model: model.identity, measurements }, null, 2));
    assert.ok(alignedRatio >= .8, `Insufficient acoustic alignment for ${voiceId}/${mode}: ${alignedRatio}`);
    console.log(JSON.stringify(measurement));
  }
}
console.log(`Comparison audio and timing reports: ${output}`);
