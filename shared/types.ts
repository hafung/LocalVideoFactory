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
  backend: 'native' | 'wsl' | 'external' | 'none';
  enginePath?: string;
  modelDir?: string;
  message: string;
}

export interface ExternalTtsStatus {
  enabled: boolean;
  baseUrl: string;
  model: string;
  voice: string;
  hasApiKey: boolean;
  speed?: number;
}

export interface ExternalTtsConfigInput {
  enabled: boolean;
  baseUrl: string;
  model: string;
  voice: string;
  apiKey?: string;
  clearApiKey?: boolean;
  speed?: number;
}

export interface ExternalTtsTestResult {
  ok: boolean;
  message: string;
  voices: string[];
  models: string[];
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
  talkingHead: import('./talking-head.js').TalkingHeadApi;
  modelSetupStatus(): Promise<import('./model-downloads.js').ModelSetupStatus>;
  startModelSetup(): Promise<void>;
  retryModelSetup(): Promise<void>;
  importLocalModels(): Promise<boolean>;
  modelStorageInfo(): Promise<import('./model-downloads.js').ModelStorageInfo>;
  setModelDownloadMirror(mirror: import('./model-downloads.js').ModelDownloadMirror): Promise<import('./model-downloads.js').ModelStorageInfo>;
  chooseModelStorage(): Promise<import('./model-downloads.js').ModelStorageMigrationResult>;
  openModelStorage(): Promise<void>;
  onModelSetupProgress(listener: (status: import('./model-downloads.js').ModelSetupStatus) => void): () => void;
  optionalModelStatus(): Promise<import('./model-downloads.js').OptionalModelStatus>;
  prepareOptionalModel(group: import('./model-downloads.js').OptionalModel): Promise<void>;
  onOptionalModelProgress(listener: (group: import('./model-downloads.js').OptionalModel, status: import('./model-downloads.js').ModelSetupStatus) => void): () => void;
  externalTtsStatus(): Promise<ExternalTtsStatus>;
  configureExternalTts(config: ExternalTtsConfigInput): Promise<ExternalTtsStatus>;
  testExternalTts(config: ExternalTtsConfigInput): Promise<ExternalTtsTestResult>;
  getStatus(): Promise<EngineStatus>;
  configure(config: { enginePath?: string; modelDir?: string }): Promise<EngineStatus>;
  semanticStatus(): Promise<{ enginePath: string; modelPath: string; configured: boolean }>;
  configureSemantic(config: { enginePath: string; modelPath: string }): Promise<{ enginePath: string; modelPath: string; configured: boolean }>;
  sceneModelStatus(): Promise<{ modelPath: string; configured: boolean; canAnalyzeSource: boolean }>;
  configureSceneModel(modelPath: string): ReturnType<VoxWeaveApi['sceneModelStatus']>;
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
  onlineSourceStatus(): Promise<OnlineSourceStatus[]>;
  configureOnlineSource(value: ConfigureOnlineSource): Promise<OnlineSourceStatus[]>;
  searchOnlineMedia(id: string, request: OnlineSearchRequest): Promise<OnlineSearchResult>;
  downloadOnlineMedia(id: string, itemId: string): Promise<OnlineDownloadResult>;
  cancelOnlineMedia(id: string): Promise<void>;
  searchMusic(request: import('./library.js').MusicSearchRequest): Promise<import('./library.js').MusicSearchResult>;
  downloadMusic(id: string): Promise<MediaAsset>;
  openSource(url: string): Promise<void>;
  updateAudio(projectId: string, settings: { bgm: EditPlan['bgm']; audio: EditPlan['audio']; playbackRate?: number }): Promise<{ plan: EditPlan; preview: NonNullable<CompositionProgressEvent['preview']> }>;
  exportVideo(projectId: string, publish?: import('./publishing.js').PublishDraft): Promise<{ jobId: string } | null>;
  suggestPublishCopy(request: import('./publishing.js').PublishCopyRequest): Promise<import('./publishing.js').PublishCopySuggestion>;
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
import type { MediaAsset, ImportReport, ConfigureOnlineSource, OnlineSourceStatus, OnlineSearchRequest, OnlineSearchResult, OnlineDownloadResult } from './library.js';
import type { SceneCandidateResult, SceneChoice } from './scene-candidates.js';
export interface ExportProgress {
  jobId: string; progress: number; phase: 'preparing' | 'capturing' | 'encoding' | 'complete' | 'error' | 'cancelled';
  message: string; outputPath?: string;
}
