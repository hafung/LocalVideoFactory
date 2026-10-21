import type { MediaAsset } from './library.js';

export type SceneChoice =
  | { type: 'asset'; assetId: string; sourceInMs?: number; throughSceneId?: string }
  | { type: 'kinetic-text'; throughSceneId?: string };

export interface SceneCandidate {
  choice: SceneChoice;
  asset: MediaAsset;
  sourceOutMs?: number;
  match: 'related' | 'semantic' | 'fill' | 'alternate';
  reasons: string[];
}

export interface SceneCandidateResult {
  query: string;
  onlineQuery?: string;
  querySource: 'scene' | 'story' | 'manual' | 'none';
  candidates: SceneCandidate[];
  notice?: string;
}
