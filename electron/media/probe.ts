import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface MediaProbe {
  probe(file: string): Promise<MediaMetadata>;
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const numerator = Number(value.split('/')[0]);
  const denominator = Number(value.split('/')[1] ?? 1);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

export class FfprobeMediaProbe implements MediaProbe {
  constructor(private readonly ffprobePath: string) {}

  async probe(file: string): Promise<MediaMetadata> {
    const { stdout } = await execFileAsync(this.ffprobePath, [
      '-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,duration',
      '-of', 'json', file
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const payload = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<Record<string, unknown>>;
    };
    const streams = payload.streams ?? [];
    const video = streams.find(stream => stream.codec_type === 'video');
    const audio = streams.find(stream => stream.codec_type === 'audio');
    // A longer soundtrack must not make source-video selection seek past the final frame.
    const durationSeconds = [video?.duration, payload.format?.duration, audio?.duration].map(Number)
      .find(duration => Number.isFinite(duration) && duration > 0) ?? NaN;
    const durationMs = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.max(1, Math.round(durationSeconds * 1000))
      : undefined;
    if (!durationMs && typeof video?.width !== 'number') throw new Error('ffprobe 未返回有效媒体信息');
    return {
      durationMs,
      width: typeof video?.width === 'number' ? video.width : undefined,
      height: typeof video?.height === 'number' ? video.height : undefined,
      fps: parseRate(video?.avg_frame_rate),
      hasAudio: Boolean(audio),
      videoCodec: typeof video?.codec_name === 'string' ? video.codec_name : undefined,
      audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : undefined
    };
  }
}

export class WavMediaProbe implements MediaProbe {
  async probe(file: string): Promise<MediaMetadata> {
    const buffer = await readFile(file);
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('不是受支持的 PCM WAV 文件');
    }
    let offset = 12;
    let bytesPerSecond = 0;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      if (id === 'fmt ' && size >= 16) bytesPerSecond = buffer.readUInt32LE(offset + 8 + 8);
      if (id === 'data') { dataBytes = size; break; }
      offset += 8 + size + (size % 2);
    }
    if (!bytesPerSecond || !dataBytes) throw new Error('WAV 文件缺少有效 fmt 或 data 区块');
    return { durationMs: Math.max(1, Math.round(dataBytes / bytesPerSecond * 1000)), hasAudio: true, audioCodec: 'pcm_s16le' };
  }
}

export class FallbackMediaProbe implements MediaProbe {
  constructor(private readonly primary: MediaProbe | undefined, private readonly wav = new WavMediaProbe()) {}

  async probe(file: string): Promise<MediaMetadata> {
    if (this.primary) return this.primary.probe(file);
    if (file.toLowerCase().endsWith('.wav')) return this.wav.probe(file);
    throw new Error('视频探测需要配置 ffprobe');
  }
}
