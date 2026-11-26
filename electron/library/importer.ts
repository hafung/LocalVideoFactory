import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImportAssetRequestSchema, MediaAssetSchema, type ImportAssetRequest, type MediaAsset } from '../../shared/library.js';
import type { MediaProbe } from '../media/probe.js';
import type { LibraryDatabase } from './database.js';
import { automaticTags } from './tags.js';

const execFileAsync = promisify(execFile);
const extensions = {
  video: new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']),
  image: new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']),
  audio: new Set(['.wav', '.flac', '.mp3', '.ogg', '.opus', '.m4a', '.aac'])
};

async function fingerprint(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function mediaType(file: string): MediaAsset['type'] {
  const extension = path.extname(file).toLowerCase();
  for (const [type, values] of Object.entries(extensions)) if (values.has(extension)) return type as MediaAsset['type'];
  throw new Error(`不支持的素材格式：${extension || '无扩展名'}`);
}

export interface Thumbnailer { create(input: string, output: string, type: MediaAsset['type']): Promise<void> }

export class FfmpegThumbnailer implements Thumbnailer {
  constructor(private readonly ffmpegPath: string) {}
  async create(input: string, output: string, type: MediaAsset['type']): Promise<void> {
    if (type === 'audio') return;
    const seek = type === 'video' ? ['-ss', '0.3'] : [];
    await execFileAsync(this.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...seek, '-i', input,
      '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", output], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  }
}

export class AssetImporter {
  constructor(
    private readonly database: LibraryDatabase,
    private readonly probe: MediaProbe,
    private readonly derivedDir: string,
    private readonly thumbnailer?: Thumbnailer
  ) {}

  async import(inputValue: ImportAssetRequest, online?: {
    name: string; signal: AbortSignal; type: MediaAsset['type']; minDurationMs: number;
  }): Promise<MediaAsset> {
    const input = ImportAssetRequestSchema.parse(inputValue);
    await access(input.filePath);
    const hash = await fingerprint(input.filePath, online?.signal);
    const validate = (type: MediaAsset['type'], durationMs?: number) => {
      online?.signal.throwIfAborted();
      if (online && (type !== online.type || (type === 'video' && (durationMs ?? 0) < Math.max(1, online.minDurationMs))))
        throw new Error('素材类型或时长不符');
    };
    const reuse = (asset: MediaAsset) => {
      if (!online) return asset;
      validate(asset.type, asset.durationMs);
      const licenses = [asset.license, ...(asset.additionalLicenses ?? [])];
      if (licenses.some(license => JSON.stringify(license) === JSON.stringify(input.license))) return asset;
      if (asset.license.status === 'unknown') return this.database.upsert({ ...asset, license: input.license, additionalLicenses: licenses });
      return this.database.upsert({ ...asset, additionalLicenses: [...(asset.additionalLicenses ?? []), input.license] });
    };
    const existing = this.database.byFingerprint(hash);
    if (existing) return reuse(existing);
    const type = mediaType(input.filePath);
    const metadata = await this.probe.probe(input.filePath);
    validate(type, metadata.durationMs);
    const id = randomUUID();
    await mkdir(this.derivedDir, { recursive: true });
    const thumbnailPath = type === 'audio' || !this.thumbnailer ? undefined : path.join(this.derivedDir, `${id}.jpg`);
    let saved = false;
    try {
      if (thumbnailPath) await this.thumbnailer!.create(input.filePath, thumbnailPath, type);
      online?.signal.throwIfAborted();
      const duplicate = this.database.byFingerprint(hash);
      if (duplicate) return reuse(duplicate);
      const name = online?.name || path.basename(input.filePath);
      const generated = automaticTags({ ...metadata, filePath: input.filePath, name: online?.name, type, transcript: '', license: input.license });
      const autoTags = online ? [...new Set([...generated, ...input.tags])] : generated;
      const asset = this.database.upsert(MediaAssetSchema.parse({
        id, filePath: path.resolve(input.filePath), fingerprint: hash, type, name, durationMs: metadata.durationMs,
        width: metadata.width, height: metadata.height, fps: metadata.fps, hasAudio: metadata.hasAudio, thumbnailPath,
        tags: [...new Set([...input.tags, ...autoTags])], autoTags, manualTags: online ? [] : input.tags,
        transcript: '', license: input.license, createdAt: new Date().toISOString()
      }));
      saved = true;
      return asset;
    } finally {
      if (!saved && thumbnailPath) await rm(thumbnailPath, { force: true }).catch(() => undefined);
    }
  }
}
