import { stat } from 'node:fs/promises';
import type { MediaAsset } from '../../shared/library.js';
import type { TalkProject } from '../../shared/talking-head.js';

/** Resolve a render copy while preserving the project's original asset choices. */
export async function resolveTalkAssets(project: TalkProject, lookup: (id: string) => MediaAsset | undefined) {
  const ids = new Set(project.overlays.filter(overlay => overlay.enabled && overlay.assetId).map(overlay => overlay.assetId!));
  const bgmId = project.audio.bgmAssetId;
  if (bgmId) ids.add(bgmId);
  const assets = new Map<string, MediaAsset>();
  await Promise.all([...ids].map(async id => {
    const asset = lookup(id);
    if (!asset) return;
    try {
      if ((await stat(asset.filePath)).isFile()) assets.set(id, asset);
    } catch { /* The library entry can outlive its file. */ }
  }));

  const overlays = project.overlays.filter(overlay => !overlay.enabled || !overlay.assetId ||
    assets.get(overlay.assetId)?.type === overlay.type);
  const bgm = bgmId ? assets.get(bgmId) : undefined;
  const missingBgm = Boolean(bgmId && (bgm?.type !== 'audio' || bgm.license.status === 'unknown'));
  const warnings: string[] = [];
  if (overlays.length < project.overlays.length) warnings.push('部分画面素材不可用，已使用人物原片。可到「画面增强」替换或移除这些素材。');
  if (missingBgm) warnings.push('配乐不可用，已保留口播原声。可到「原声与配乐」重新选择。');
  return {
    project: { ...project, overlays, audio: missingBgm ? { ...project.audio, bgmAssetId: undefined } : project.audio },
    warnings,
    resolve(id: string) {
      const asset = assets.get(id);
      if (!asset) throw new Error('画面或配乐素材不存在，请重新选择');
      return asset;
    }
  };
}
