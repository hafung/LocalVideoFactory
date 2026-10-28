export const LANGUAGES = ['Auto', 'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'] as const;
export type Language = typeof LANGUAGES[number];
export const AUDIO_FORMATS = ['wav', 'flac', 'mp3', 'opus', 'm4a'] as const;
export type AudioFormat = typeof AUDIO_FORMATS[number];

export interface VoiceProfile {
  id: string;
  name: string;
  kind: 'preset' | 'clone';
  path?: string;
  language?: Language;
  createdAt?: string;
}

export interface SynthesisRequest {
  text: string;
  outputPath: string;
  outputFormat?: AudioFormat;
  modelDir?: string;
  language: Language;
  speaker?: string;
  voicePath?: string;
  referenceAudio?: string;
  referenceText?: string;
  temperature: number;
  topK: number;
  topP: number;
  seed?: number;
  threads: number;
  precision: 'bf16' | 'int8' | 'int4';
  automaticProsody?: boolean;
  instruct?: string;
  rate?: number;
}

export interface EngineStatus {
  state: 'missing' | 'idle' | 'working' | 'error';
  backend: 'native' | 'wsl' | 'none';
  enginePath?: string;
  modelDir?: string;
  message: string;
}

export interface ProgressEvent {
  phase: 'preparing' | 'encoding' | 'generating' | 'composing' | 'complete' | 'error';
  progress?: number;
  message: string;
  outputPath?: string;
}

export type CompositionPhase = 'drafting' | 'narrating' | 'resolving' | 'aligning' | 'selecting' | 'compiling' | 'complete' | 'cancelled' | 'error';

export interface CompositionProgressEvent {
  jobId: string;
  phase: CompositionPhase;
  progress: number;
  message: string;
  plan?: EditPlan;
  preview?: { entryUrl: string; durationMs: number; width: number; height: number };
  recoverable?: boolean;
}

export interface GenerateCompositionRequest extends DraftPlanRequest {
  language?: Language;
  temperature?: number;
  precision?: SynthesisRequest['precision'];
  bgm?: EditPlan['bgm'];
  audio?: EditPlan['audio'];
  playbackRate?: number;
}

export interface VoxWeaveApi {
  modelSetupStatus(): Promise<import('./model-downloads.js').ModelSetupStatus>;
  retryModelSetup(): Promise<void>;
  onModelSetupProgress(listener: (status: import('./model-downloads.js').ModelSetupStatus) => void): () => void;
  getStatus(): Promise<EngineStatus>;
  configure(config: { enginePath?: string; modelDir?: string }): Promise<EngineStatus>;
  semanticStatus(): Promise<{ enginePath: string; modelPath: string; configured: boolean }>;
  configureSemantic(config: { enginePath: string; modelPath: string }): Promise<{ enginePath: string; modelPath: string; configured: boolean }>;
  sceneModelStatus(): Promise<{ modelPath: string; configured: boolean }>;
  configureSceneModel(modelPath: string): Promise<{ modelPath: string; configured: boolean }>;
  chooseFile(kind: 'audio' | 'video' | 'engine' | 'model' | 'semantic-engine' | 'semantic-model' | 'scene-model'): Promise<string | null>;
  listVoices(): Promise<VoiceProfile[]>;
  cloneVoice(input: { name: string; referenceAudioPath: string }): Promise<VoiceProfile>;
  chooseOutput(defaultName: string, format?: AudioFormat): Promise<string | null>;
  createDraftPlan(request: DraftPlanRequest): Promise<EditPlan>;
  generateComposition(request: GenerateCompositionRequest): Promise<{ jobId: string; projectId: string }>;
  cancelComposition(jobId: string): Promise<void>;
  updateCaptions(projectId: string, settings: { mode: import('./edit-plan.js').CaptionHighlight; edits?: Array<{ cueId: string; text: string }> }): Promise<{ plan: EditPlan; preview: NonNullable<CompositionProgressEvent['preview']> }>;
  resumeLastProject(): Promise<{ plan: EditPlan; preview?: CompositionProgressEvent['preview'] } | null>;
  listSceneCandidates(projectId: string, sceneId: string, query?: string, throughSceneId?: string): Promise<SceneCandidateResult>;
  replaceScene(projectId: string, sceneId: string, choice: SceneChoice): Promise<
    | { status: 'replaced'; plan: EditPlan; preview: NonNullable<CompositionProgressEvent['preview']> }
    | { status: 'unavailable'; message: string }
  >;
  importAssets(type?: MediaAsset['type']): Promise<ImportReport>;
  importAsset(filePath: string): Promise<MediaAsset>;
  listAssets(): Promise<MediaAsset[]>;
  searchAssets(query: string, type?: MediaAsset['type']): Promise<MediaAsset[]>;
  updateAssetTags(ids: string[], tags: string[], mode: 'replace' | 'append'): Promise<void>;
  autoTagAssets(ids: string[]): Promise<void>;
  removeAssets(ids: string[]): Promise<void>;
  pexelsStatus(): Promise<{ configured: boolean }>;
  configurePexels(key: string): Promise<void>;
  searchPexels(request: { query: string; type: 'video' | 'image'; page: number; orientation?: 'portrait' | 'landscape' | 'square' }): Promise<{ items: OnlineAsset[]; query: string }>;
  downloadPexels(id: string): Promise<MediaAsset>;
  searchMusic(request: import('./library.js').MusicSearchRequest): Promise<import('./library.js').MusicSearchResult>;
  downloadMusic(id: string): Promise<MediaAsset>;
  openSource(url: string): Promise<void>;
  updateAudio(projectId: string, settings: { bgm: EditPlan['bgm']; audio: EditPlan['audio']; playbackRate?: number }): Promise<{ plan: EditPlan; preview: NonNullable<CompositionProgressEvent['preview']> }>;
  exportVideo(projectId: string): Promise<{ jobId: string } | null>;
  exportArtifact(projectId: string, kind: 'narration-mp3' | 'mixed-mp3' | 'srt' | 'ass'): Promise<{ outputPath: string } | null>;
  cancelExport(jobId: string): Promise<void>;
  onExportProgress(listener: (event: ExportProgress) => void): () => void;
  synthesize(request: SynthesisRequest): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  onProgress(listener: (event: ProgressEvent & { jobId: string }) => void): () => void;
  onCompositionProgress(listener: (event: CompositionProgressEvent) => void): () => void;
}
import type { DraftPlanRequest, EditPlan } from './edit-plan.js';
import type { MediaAsset, ImportReport, OnlineAsset } from './library.js';
import type { SceneCandidateResult, SceneChoice } from './scene-candidates.js';
export interface ExportProgress {
  jobId: string; progress: number; phase: 'preparing' | 'capturing' | 'encoding' | 'complete' | 'error' | 'cancelled';
  message: string; outputPath?: string;
}
