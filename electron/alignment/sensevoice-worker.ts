import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { SenseVoiceAdapter, verifySenseVoiceResources } from './sensevoice.js';

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const resources = await verifySenseVoiceResources(requiredOption('--resources'));
  const audioPath = requiredOption('--audio');
  const resultPath = requiredOption('--result');
  const adapter = new SenseVoiceAdapter(resources);
  if (process.argv.includes('--source')) {
    const result = await adapter.transcribeSpeech(audioPath);
    await writeFile(resultPath, `${JSON.stringify({ ...result, speechEndMs: result.speechSegments.at(-1)?.endMs })}\n`, 'utf8');
    return;
  }
  const [tokens, speechEndMs] = await Promise.all([
    adapter.transcribe(audioPath),
    adapter.speechEndMs(audioPath)
  ]);
  await writeFile(resultPath, `${JSON.stringify({ tokens, speechEndMs })}\n`, 'utf8');
}

try {
  await main();
  // sherpa-onnx has crashed during Electron main-process teardown on Windows.
  // This worker owns the native addon, and an explicit clean exit avoids
  // running native destructors inside the long-lived desktop process.
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
