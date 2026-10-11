import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const normalize = text => text.normalize('NFKC').toLowerCase()
  .replace(/<\|[^|]*\|>/gu, '').replace(/[\p{P}\p{S}\s]/gu, '');

function errors(reference, hypothesis) {
  const a = Array.from(normalize(reference)), b = Array.from(normalize(hypothesis));
  const cost = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) cost[i][0] = i;
  for (let j = 0; j <= b.length; j++) cost[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1,
      cost[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  let i = a.length, j = b.length;
  const edits = [];
  while (i || j) {
    if (i && j && cost[i][j] === cost[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) edits.push({ type: 'substitution', expected: a[i - 1], actual: b[j - 1] });
      i--; j--;
    } else if (i && cost[i][j] === cost[i - 1][j] + 1) {
      edits.push({ type: 'deletion', expected: a[--i] });
    } else edits.push({ type: 'insertion', actual: b[--j] });
  }
  return { referenceCharacters: a.length, distance: cost[a.length][b.length],
    cer: cost[a.length][b.length] / Math.max(1, a.length), edits: edits.reverse() };
}

function waveData(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    const kind = bytes.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') format = { pcm: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
      rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    if (kind === 'data') data = { start, size };
    offset = start + size + size % 2;
  }
  if (!format || !data || format.pcm !== 1 || format.bits !== 16) throw new Error('Expected PCM16 WAV');
  return { ...format, ...data, durationMs: data.size * 1000 / (format.rate * format.channels * 2) };
}

function addNoise(original, snrDb, initialSeed) {
  const output = Buffer.from(original), wav = waveData(output), count = wav.size / 2;
  let energy = 0, seed = initialSeed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 1) / 4294967297; };
  const noise = new Float64Array(count);
  let noiseEnergy = 0;
  for (let i = 0; i < count; i++) {
    const value = output.readInt16LE(wav.start + i * 2);
    energy += value * value;
    noise[i] = Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
    noiseEnergy += noise[i] ** 2;
  }
  const gain = Math.sqrt(energy / noiseEnergy / 10 ** (snrDb / 10));
  let clippedSamples = 0;
  for (let i = 0; i < count; i++) {
    const mixed = Math.round(output.readInt16LE(wav.start + i * 2) + noise[i] * gain);
    if (mixed < -32768 || mixed > 32767) clippedSamples++;
    output.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), wav.start + i * 2);
  }
  return { bytes: output, clippedSamples };
}

if (process.argv.includes('--sensevoice-worker')) {
  const { SenseVoiceAdapter, verifySenseVoiceResources } = await import(pathToFileURL(path.join(root, 'dist-electron/electron/alignment/sensevoice.js')));
  const resources = await verifySenseVoiceResources(path.join(root, 'resources/models/sensevoice-small'));
  const adapter = new SenseVoiceAdapter(resources);
  let start = performance.now();
  const tokens = await adapter.transcribe(option('--audio'));
  const recognitionMs = performance.now() - start;
  start = performance.now();
  const speechEndMs = await adapter.speechEndMs(option('--audio'));
  const result = JSON.stringify({ transcript: tokens.map(token => token.text).join(''), tokens,
    recognitionMs, vadMs: performance.now() - start, speechEndMs });
  if (option('--result')) await writeFile(option('--result'), result);
  else process.stdout.write(result);
} else {
  if (process.platform !== 'linux') throw new Error('This comparison uses Linux /usr/bin/time. Run both engines in WSL.');
  const binary = path.resolve(option('--qwen-bin', path.join(root, '.windows-smoke/asr-compare/runtime/qwen_asr')));
  const model = path.resolve(option('--qwen-model', path.join(root, '.windows-smoke/asr-compare/models/qwen3-asr-1.7b')));
  const stress = process.argv.includes('--stress');
  const output = path.resolve(option('--output', path.join(root, stress ? '.windows-smoke/asr-compare-stress' : '.windows-smoke/asr-compare')));
  const repetitions = Number(option('--repetitions', '3'));
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Invalid repetitions');
  await mkdir(path.join(output, 'samples'), { recursive: true });
  await mkdir(path.join(output, 'runs'), { recursive: true });
  const prosody = JSON.parse(await readFile(path.join(root, '.windows-smoke/prosody-check/report.json'), 'utf8'));
  const clone = JSON.parse(await readFile(path.join(root, '.windows-smoke/clone-check/report.json'), 'utf8'));
  const samples = stress ? [
    { id: 'preset-noise-0db', source: '.windows-smoke/prosody-check/automatic/narration/narration.wav', text: prosody.script, snrDb: 0 },
    { id: 'clone-noise-0db', source: '.windows-smoke/clone-check/narration.wav', text: clone.script, snrDb: 0 }
  ] : [
    { id: 'preset-clean', source: '.windows-smoke/prosody-check/automatic/narration/narration.wav', text: prosody.script },
    { id: 'clone-clean', source: '.windows-smoke/clone-check/narration.wav', text: clone.script },
    { id: 'short-clean', source: '.windows-smoke/qwen-engine-adapter.wav', text: '你好。' },
    { id: 'preset-noise-10db', source: '.windows-smoke/prosody-check/automatic/narration/narration.wav', text: prosody.script, snrDb: 10 },
    { id: 'clone-noise-10db', source: '.windows-smoke/clone-check/narration.wav', text: clone.script, snrDb: 10 },
    { id: 'official-chinese', source: '.windows-smoke/asr-compare/official-asr-zh.wav', text: '甚至出现交易几乎停滞的情况。',
      referenceSource: 'https://github.com/QwenLM/Qwen3-ASR#forcedaligner-usage',
      audioSource: 'https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav' }
  ];
  for (const sample of samples) {
    let bytes = await readFile(path.join(root, sample.source));
    if (sample.snrDb !== undefined) {
      const noisy = addNoise(bytes, sample.snrDb, 42);
      bytes = noisy.bytes;
      sample.noiseSeed = 42; sample.clippedSamples = noisy.clippedSamples;
    }
    sample.file = path.join(output, 'samples', `${sample.id}.wav`);
    sample.durationMs = waveData(bytes).durationMs;
    sample.sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(sample.file, bytes);
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'resources/models/sensevoice-small/manifest.json'), 'utf8'));
  const report = { createdAt: new Date().toISOString(), platform: process.platform, os: os.release(), cpu: os.cpus()[0]?.model,
    threads: 4, repetitions, timing: 'Fresh process for every run; end-to-end includes model load, file read and process startup. Later runs benefit from OS file cache. Engines run sequentially with alternating order.',
    accuracy: 'CER against original TTS script or official example reference, NFKC normalized, ignoring punctuation, symbols and whitespace. Most samples are synthetic; the official Chinese example supplements them. This is a small sample comparison, not a representative ASR benchmark.',
    timestampLimit: 'No manually annotated timing ground truth. Timestamp presence and validity are checked; timestamp accuracy is not measured. antirez/qwen-asr has no timestamp/forced-aligner output.',
    engines: { qwen: { model: 'Qwen3-ASR-1.7B', modelRevision: '7278e1e70fe206f11671096ffdd38061171dd6e5',
      source: 'https://github.com/antirez/qwen-asr', sourceCommit: '924694251d9e0f18e5d86bbd06aa3ab5f870002d',
      binary, modelDirectory: model, precision: 'CPU f32 encoder and BF16 decoder', timestamps: false },
    sensevoice: { model: 'SenseVoiceSmall INT8', resourceVersion: manifest.version, runtime: 'sherpa-onnx-node 1.13.8', timestamps: true,
      extras: 'Silero VAD and existing VoxWeave text alignment' } }, samples, runs: [] };
  const self = fileURLToPath(import.meta.url);
  const { alignTextTokens, alignedCaptionCues } = await import(pathToFileURL(path.join(root, 'dist-electron/electron/alignment/align-text.js')));
  const { readWavTiming } = await import(pathToFileURL(path.join(root, 'dist-electron/shared/wav.js')));
  const stamp = milliseconds => {
    const ms = Math.round(milliseconds);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  for (let pass = 0; pass < repetitions; pass++) for (const sample of samples) {
    for (const engine of pass % 2 ? ['qwen', 'sensevoice'] : ['sensevoice', 'qwen']) {
      const name = `${sample.id}-${engine}-${pass + 1}`;
      const memoryFile = path.join(output, 'runs', `${name}.memory.json`);
      const resultFile = path.join(output, 'runs', `${name}.result.json`);
      const command = engine === 'qwen' ? binary : process.execPath;
      const args = engine === 'qwen' ? ['-d', model, '-i', sample.file, '-t', '4', '--language', 'Chinese']
        : [self, '--sensevoice-worker', '--audio', sample.file, '--result', resultFile];
      if (engine === 'sensevoice') await writeFile(resultFile, '');
      console.log(`Running ${name}`);
      const started = performance.now();
      const { stdout, stderr } = await exec('/usr/bin/time', ['-f', '{"peakRssKiB":%M}', '-o', memoryFile, command, ...args], {
        env: { ...process.env, OPENBLAS_NUM_THREADS: '4', OMP_NUM_THREADS: '4' }, timeout: 300000, maxBuffer: 8 * 1024 * 1024
      });
      const wallMs = performance.now() - started;
      await writeFile(path.join(output, 'runs', `${name}.stdout.txt`), stdout);
      await writeFile(path.join(output, 'runs', `${name}.stderr.txt`), stderr);
      const payload = engine === 'qwen' ? stdout.trim() : await readFile(resultFile, 'utf8');
      if (engine === 'sensevoice' && !payload.trim()) throw new Error(`${name}: worker produced no result file; stderr: ${stderr.trim()}`);
      const result = engine === 'qwen' ? { transcript: payload } : JSON.parse(payload);
      const memory = JSON.parse(await readFile(memoryFile, 'utf8'));
      const run = { sample: sample.id, engine, pass: pass + 1, wallMs, rtf: wallMs / sample.durationMs, ...memory,
        ...result, ...errors(sample.text, result.transcript) };
      if (engine === 'qwen') {
        const inference = stderr.match(/Inference: ([\d.]+) ms, (\d+) text tokens .*encoding: ([\d.]+)ms, decoding: ([\d.]+)ms/u);
        if (inference) run.inference = { totalMs: Number(inference[1]), textTokens: Number(inference[2]),
          encodingMs: Number(inference[3]), decodingMs: Number(inference[4]) };
      }
      if (engine === 'sensevoice') {
        const bounds = await readWavTiming(sample.file);
        const endMs = Math.min(bounds.speechEndMs, result.speechEndMs ?? bounds.speechEndMs);
        const aligned = alignTextTokens(sample.text, result.tokens, bounds.speechStartMs, endMs);
        run.alignedCharacters = aligned.filter(token => token.source === 'aligned').length;
        run.captionCues = alignedCaptionCues(sample.id, sample.text, result.tokens, bounds.speechStartMs, endMs);
        run.invalidTimestampTokens = result.tokens.filter(token => token.startMs < 0 || token.startMs > sample.durationMs
          || (token.endMs !== undefined && (token.endMs <= token.startMs || token.endMs > sample.durationMs))).length;
        const srt = run.captionCues.map((cue, index) => `${index + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`).join('\n');
        await writeFile(path.join(output, 'runs', `${name}.srt`), srt);
      }
      report.runs.push(run);
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(`${name}: CER ${(run.cer * 100).toFixed(1)}%, ${(wallMs / 1000).toFixed(3)}s, RSS ${(memory.peakRssKiB / 1024).toFixed(0)} MiB; ${result.transcript}`);
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  report.summary = samples.map(sample => ({ sample: sample.id, durationMs: sample.durationMs,
    engines: Object.fromEntries(['sensevoice', 'qwen'].map(engine => {
      const runs = report.runs.filter(run => run.sample === sample.id && run.engine === engine);
      return [engine, { medianWallMs: median(runs.map(run => run.wallMs)), medianRtf: median(runs.map(run => run.rtf)),
        medianPeakRssMiB: median(runs.map(run => run.peakRssKiB / 1024)), cer: runs[0].cer,
        transcriptsStable: new Set(runs.map(run => run.transcript)).size === 1 }];
    })) }));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary, null, 2));
}
