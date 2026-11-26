import path from 'node:path';
import { expandKeywords } from '../../shared/keywords.js';
import { isOnlineSource, onlineSources, type MediaAsset } from '../../shared/library.js';

const genericPathParts = new Set(['downloads', 'download', 'media', 'library', '素材', ...onlineSources, 'openverse', 'video', 'image', 'audio']);
const fromOnline = (source?: string) => source !== undefined && (source === 'openverse' || isOnlineSource(source));

export function cleanAutomaticTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(tag =>
    tag.length > 1 && tag.length <= 60 &&
    !genericPathParts.has(tag.toLowerCase()) &&
    !/^\d+$/u.test(tag) &&
    !/^(?=[a-f0-9]*\d)[a-f0-9]{4,}$/iu.test(tag) &&
    !/^[\p{P}\p{S}]+$/u.test(tag)
  ))];
}

export function automaticTags(asset: Pick<MediaAsset, 'filePath' | 'type' | 'width' | 'height' | 'durationMs' | 'transcript'> & { name?: string; license?: MediaAsset['license'] }): string[] {
  const filename = path.basename(asset.filePath, path.extname(asset.filePath));
  const directory = path.basename(path.dirname(asset.filePath));
  const sourceText = fromOnline(asset.license?.source)
    ? `${asset.name ?? ''} ${asset.transcript}`
    : `${filename.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/giu, ' ')} ${directory} ${asset.name ?? ''} ${asset.transcript}`;
  const tags = cleanAutomaticTags(expandKeywords(sourceText));
  tags.push({ video: '视频', image: '图片', audio: '音频' }[asset.type]);
  if (asset.width && asset.height) {
    tags.push(asset.width / asset.height > 1.15 ? '横屏' : asset.height / asset.width > 1.15 ? '竖屏' : '方形');
    if (Math.max(asset.width, asset.height) >= 1920) tags.push('高清');
  }
  return [...new Set(tags)].slice(0, 100);
}

export function refreshedAutomaticTags(asset: MediaAsset): string[] {
  return [...new Set([...automaticTags(asset), ...(fromOnline(asset.license.source) ? cleanAutomaticTags(asset.autoTags) : [])])];
}
