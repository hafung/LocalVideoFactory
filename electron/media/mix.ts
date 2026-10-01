import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface MixOptions {
  playbackRate?: number;
  narrationVolume?: number;
  original?: { path: string; volume: number; ducking: boolean };
  bgm?: { path: string; volume: number; ducking: boolean };
}

export function mixArguments(narration: string, output: string, durationMs: number, options: MixOptions = {}): string[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('无效的旁白时长');
  for (const [name, volume] of [['旁白', options.narrationVolume ?? 1], ['原声', options.original?.volume], ['配乐', options.bgm?.volume]] as const) {
    if (volume !== undefined && (!Number.isFinite(volume) || volume < 0 || volume > 2)) throw new Error(`无效的${name}音量`);
  }
  const duration = durationMs / 1000;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', narration];
  const tracks: string[] = [];
  const filters: string[] = [];
  let nextInput = 1;
  let sideCount = 0;

  if (options.original) {
    args.push('-i', options.original.path);
    filters.push(`[${nextInput++}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${options.original.volume},apad,atrim=duration=${duration}[original]`);
    if (options.original.ducking) sideCount++;
    tracks.push('original');
  }
  if (options.bgm) {
    args.push('-stream_loop', '-1', '-i', options.bgm.path);
    filters.push(`[${nextInput}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${options.bgm.volume},afade=t=in:d=${Math.min(.5, duration / 4)},afade=t=out:st=${Math.max(0, duration - 1)}:d=${Math.min(1, duration)}[bgm]`);
    if (options.bgm.ducking) sideCount++;
    tracks.push('bgm');
  }

  filters.unshift(`[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration},loudnorm=I=-16:TP=-1.5:LRA=11,volume=${options.narrationVolume ?? 1}${sideCount ? `,asplit=${sideCount + 1}[voice]${Array.from({ length: sideCount }, (_, index) => `[side${index}]`).join('')}` : '[voice]'}`);
  let sideIndex = 0;
  if (options.original?.ducking) filters.push(`[original][side${sideIndex++}]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350[originalDuck]`);
  if (options.bgm?.ducking) filters.push(`[bgm][side${sideIndex++}]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=350[bgmDuck]`);
  const mixInputs = ['voice', ...tracks.map(track => track === 'original' && options.original?.ducking ? 'originalDuck'
    : track === 'bgm' && options.bgm?.ducking ? 'bgmDuck' : track)];
  if (mixInputs.length > 1) filters.push(`${mixInputs.map(track => `[${track}]`).join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[mixed]`);
  const rate = options.playbackRate ?? 1;
  if (!Number.isFinite(rate) || rate < .25 || rate > 4) throw new Error('倍速必须在 0.25–4 之间');
  const tempo = rate < .5 ? `atempo=0.5,atempo=${rate / .5}` : rate > 2 ? `atempo=2,atempo=${rate / 2}` : `atempo=${rate}`;
  filters.push(`[${mixInputs.length > 1 ? 'mixed' : 'voice'}]atrim=duration=${duration},alimiter=limit=0.95:level=0${rate === 1 ? '' : ',' + tempo}[out]`);
  return [...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-t', String(duration / (options.playbackRate ?? 1)), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', output];
}

export async function mixNarration(ffmpeg: string, narration: string, output: string, durationMs: number,
  options: MixOptions = {}, signal?: AbortSignal): Promise<void> {
  await run(ffmpeg, mixArguments(narration, output, durationMs, options), { windowsHide: true, signal, maxBuffer: 4 * 1024 * 1024 });
}
