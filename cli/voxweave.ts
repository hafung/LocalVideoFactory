#!/usr/bin/env node
import { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { QwenEngine } from '../electron/engine.js';
import { AUDIO_FORMATS, LANGUAGES, type AudioFormat, type Language, type SynthesisRequest } from '../shared/types.js';

const program = new Command();
program.name('voxweave').description('帧舟 FrameSkiff · Qwen3-TTS 本地语音合成 CLI').version('0.2.11');
program
  .requiredOption('-t, --text <text>', '普通文案，自动处理朗读节奏与段落停顿')
  .requiredOption('-o, --output <wav>', '输出 WAV 路径')
  .option('--engine <path>', 'qwen_tts.exe 或 WSL 内 qwen_tts 路径', process.env.VOXWEAVE_ENGINE)
  .option('-m, --model <dir>', '模型目录', process.env.VOXWEAVE_MODEL)
  .option('-l, --language <name>', `语言：${LANGUAGES.join(', ')}`, 'Auto')
  .option('-s, --speaker <name>', '内置音色名称')
  .option('--voice <file>', '.qvoice 克隆音色文件')
  .option('--ref-audio <wav>', '用于即时音色克隆的参考 WAV')
  .option('--ref-text <text>', '参考音频原文（预留元数据）')
  .option('--temperature <number>', '采样温度', '0.5')
  .option('--top-k <number>', 'Top-k', '50')
  .option('--top-p <number>', 'Top-p', '1.0')
  .option('--seed <number>', '随机种子')
  .option('-j, --threads <number>', '线程数', String(Math.min(4, os.cpus().length)))
  .option('--precision <mode>', 'bf16 | int8 | int4', 'int8')
  .option('--no-automatic-prosody', '关闭自动朗读处理，用于对照试听')
  .option('-f, --format <format>', 'wav | flac | mp3 | opus | m4a（默认根据扩展名判断）')
  .option('--ffmpeg <path>', 'ffmpeg.exe 路径', process.env.VOXWEAVE_FFMPEG)
  .action(async options => {
    if (options.format && !AUDIO_FORMATS.includes(options.format as AudioFormat)) program.error(`format 必须是 ${AUDIO_FORMATS.join(', ')}`);
    if (!options.engine || !options.model) program.error('必须通过 --engine/--model 或 VOXWEAVE_ENGINE/VOXWEAVE_MODEL 配置引擎与模型');
    if (!LANGUAGES.includes(options.language as Language)) program.error(`不支持的语言：${options.language}`);
    if (!['bf16', 'int8', 'int4'].includes(options.precision)) program.error('precision 必须是 bf16、int8 或 int4');
    const voicePath = options.voice && path.resolve(options.voice);
    const modelDir = path.resolve(options.model);
    const request: SynthesisRequest = {
      text: options.text, outputPath: path.resolve(options.output), outputFormat: options.format, modelDir, language: options.language,
      speaker: options.speaker, voicePath, referenceAudio: options.refAudio && path.resolve(options.refAudio),
      referenceText: options.refText, temperature: Number(options.temperature), topK: Number(options.topK), topP: Number(options.topP),
      seed: options.seed === undefined ? undefined : Number(options.seed), threads: Number(options.threads), precision: options.precision,
      automaticProsody: options.automaticProsody
    };
    const engine = new QwenEngine({ enginePath: options.engine, modelDir, ffmpegPath: options.ffmpeg });
    await engine.synthesize(request, event => {
      if (event.progress !== undefined) process.stderr.write(`\r${Math.round(event.progress * 100)}% ${event.message.padEnd(36)}`);
      else process.stderr.write(`\n${event.message}`);
    });
    process.stderr.write('\n');
    process.stdout.write(`${request.outputPath}\n`);
  });

program.parseAsync()
  .catch(error => { console.error(`voxweave: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; })
  .finally(() => { if (process.versions.electron) process.exit(process.exitCode ?? 0); });
