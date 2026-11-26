import '@hyperframes/player';
import './library.css';
import { LibraryPanel } from './LibraryPanel';
import { OnlineSourceSettings } from './OnlineMedia';
import { ModelProgress } from './ModelProgress';
import { Modal } from './Modal';
import { ScenePicker } from './ScenePicker';
import { PublishPanel } from './PublishPanel';
import type { HyperframesPlayer } from '@hyperframes/player';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Check, ChevronDown, Download, Film, FolderOpen, Image,
  Play, Plus, RefreshCw, Settings2, Sparkles, Square, Upload, Video, WandSparkles, X
} from 'lucide-react';
import { estimateDuration } from '../shared/markup';
import type { EditPlan, CaptionCue } from '../shared/edit-plan';
import type { MediaAsset } from '../shared/library';
import type { SceneChoice } from '../shared/scene-candidates';
import type { CompositionProgressEvent, EngineStatus, GenerateCompositionRequest, ExportProgress, VoiceProfile } from '../shared/types';
import type { ModelSetupStatus, OptionalModel, OptionalModelStatus } from '../shared/model-downloads';
import type { PublishDraft } from '../shared/publishing';

const api = () => window.voxweave;
function captionAnnotation(cue: CaptionCue): string {
  if (cue.manualGrouping) return cue.manualGrouping;
  const boundaries = new Set(cue.highlightUnits?.slice(1).map(unit => unit.startChar));
  return Array.from(cue.text).map((char, index) => `${boundaries.has(index) ? '|' : ''}${char}`).join('');
}
const voices = [
  { id: 'vivian', name: 'Vivian', note: '中文女声 · 清晰自然' },
  { id: 'serena', name: 'Serena', note: '中文女声 · 沉稳温暖' },
  { id: 'uncle_fu', name: 'Uncle Fu', note: '中文男声 · 沉稳' },
  { id: 'dylan', name: 'Dylan', note: '中文男声 · 活力' },
  { id: 'ryan', name: 'Ryan', note: '英文男声 · 叙事感' },
  { id: 'aiden', name: 'Aiden', note: '英文男声' },
  { id: 'eric', name: 'Eric', note: '英文男声' },
  { id: 'ono_anna', name: 'Ono Anna', note: '日语女声' },
  { id: 'sohee', name: 'Sohee', note: '韩语女声' }
];
const voiceLanguages: Record<string, GenerateCompositionRequest['language']> = {
  ryan: 'English', aiden: 'English', eric: 'English', ono_anna: 'Japanese', sohee: 'Korean'
};
const stages: Array<{ phase: CompositionProgressEvent['phase']; label: string }> = [
  { phase: 'drafting', label: '分镜' }, { phase: 'narrating', label: '旁白' },
  { phase: 'aligning', label: '字幕' }, { phase: 'resolving', label: '时间轴' },
  { phase: 'selecting', label: '素材' }, { phase: 'compiling', label: '预览' }
];

type Preview = NonNullable<CompositionProgressEvent['preview']>;
const modelSizes: Record<OptionalModel, string> = { scene: '3.4 GB', search: '640 MB', clone: '3.9 GB' };

export type WorkspaceDialog = 'settings' | 'library' | 'audio' | 'online';

export function App({ active, dialog, openDialog, assets, refreshAssets }: {
  active: boolean; dialog?: WorkspaceDialog; openDialog: (dialog?: WorkspaceDialog) => void;
  assets: MediaAsset[]; refreshAssets: () => Promise<void>;
}) {
  const [script, setScript] = useState('产品很好，却一直卖不出去？问题也许不在产品，而在表达。让帧舟把文案、旁白和画面编成一条完整视频。');
  const [voiceId, setVoiceId] = useState('vivian');
  const [clonedVoices, setClonedVoices] = useState<VoiceProfile[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneReference, setCloneReference] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [aspectRatio, setAspectRatio] = useState<NonNullable<GenerateCompositionRequest['aspectRatio']>>('9:16');
  const [captionStyle, setCaptionStyle] = useState<NonNullable<GenerateCompositionRequest['captionStyle']>>('commerce-bold');
  const [captionHighlight, setCaptionHighlight] = useState<NonNullable<GenerateCompositionRequest['captionHighlight']>>('word');
  const [captionBusy, setCaptionBusy] = useState(false);
  const [captionEditor, setCaptionEditor] = useState(false);
  const [captionEdits, setCaptionEdits] = useState<Record<string, string>>({});
  const [captionError, setCaptionError] = useState('');
  const [sourceVideoPath, setSourceVideoPath] = useState<string>();
  const [moreOpen, setMoreOpen] = useState(false);
  const settingsOpen = dialog === 'settings';
  const libraryView = settingsOpen ? undefined : dialog;
  const [exportProgress, setExportProgress] = useState<ExportProgress>();
  const [exportJob, setExportJob] = useState<string>();
  const [exportPending, setExportPending] = useState(false);
  const [bgmAsset, setBgmAsset] = useState('');
  const [bgmVolume, setBgmVolume] = useState(.15);
  const [bgmDucking, setBgmDucking] = useState(true);
  const [bgmBusy, setBgmBusy] = useState(false);
  const [generatePending, setGeneratePending] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [narrationVolume, setNarrationVolume] = useState(1);
  const [originalEnabled, setOriginalEnabled] = useState(false);
  const [originalVolume, setOriginalVolume] = useState(.35);
  const [originalDucking, setOriginalDucking] = useState(true);
  const [status, setStatus] = useState<EngineStatus>({ state: 'missing', backend: 'none', message: '正在检测本地引擎…' });
  const [modelSetup, setModelSetup] = useState<ModelSetupStatus>();
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [setupRequested, setSetupRequested] = useState(false);
  const [optionalModels, setOptionalModels] = useState<OptionalModelStatus>();
  const [optionalRequests, setOptionalRequests] = useState<Partial<Record<OptionalModel, boolean>>>({});
  const [optionalErrors, setOptionalErrors] = useState<Partial<Record<OptionalModel, string>>>({});
  const [modelImportPending, setModelImportPending] = useState(false);
  const [modelImportError, setModelImportError] = useState('');
  const [modelImportNotice, setModelImportNotice] = useState('');
  const [enginePath, setEnginePath] = useState('');
  const [modelDir, setModelDir] = useState('');
  const [engineNotice, setEngineNotice] = useState('');
  const [semanticEnginePath, setSemanticEnginePath] = useState('');
  const [semanticModelPath, setSemanticModelPath] = useState('');
  const [semanticConfigured, setSemanticConfigured] = useState(false);
  const [sceneModelPath, setSceneModelPath] = useState('');
  const [sceneConfigured, setSceneConfigured] = useState(false);
  const [sourceAnalysisReady, setSourceAnalysisReady] = useState(false);
  const [sceneModelNotice, setSceneModelNotice] = useState('');
  const [semanticNotice, setSemanticNotice] = useState('');
  const [jobId, setJobId] = useState<string>();
  const jobRef = useRef<string | undefined>(undefined);
  const [projectId, setProjectId] = useState<string>();
  const [progress, setProgress] = useState<CompositionProgressEvent>();
  const [plan, setPlan] = useState<EditPlan>();
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState<string>();
  const [replacingScene, setReplacingScene] = useState<string>();
  const [candidateSceneId, setCandidateSceneId] = useState<string>();
  const playerRef = useRef<HyperframesPlayer>(null);
  const finishedExport = useRef<string | undefined>(undefined);

  async function refreshModelSettings() {
    const desktop = api();
    if (!desktop) return;
    await Promise.all([
      desktop.optionalModelStatus?.().then(setOptionalModels),
      desktop.semanticStatus?.().then(result => {
        setSemanticEnginePath(result.enginePath); setSemanticModelPath(result.modelPath); setSemanticConfigured(result.configured);
      }),
      desktop.sceneModelStatus?.().then(result => {
        setSceneModelPath(result.modelPath); setSceneConfigured(result.configured); setSourceAnalysisReady(result.canAnalyzeSource);
      })
    ]);
  }

  useEffect(() => {
    const desktop = api();
    if (!desktop?.modelSetupStatus) return;
    let mounted = true;
    let receivedProgress = false;
    const update = (value: ModelSetupStatus) => {
      if (!mounted) return;
      setModelSetup(value);
      if (value.state === 'ready') {
        setSetupRequested(false);
        setSetupDismissed(true);
        void desktop.getStatus().then(result => {
          if (!mounted) return;
          setStatus(result);
          setEnginePath(previous => previous || result.enginePath || '');
          setModelDir(previous => previous || result.modelDir || '');
        }).catch(() => undefined);
      }
    };
    const unsubscribe = desktop.onModelSetupProgress(value => { receivedProgress = true; update(value); });
    const unsubscribeOptional = desktop.onOptionalModelProgress?.((group, progress) => {
      setOptionalModels(current => current && { ...current, [group]: { ...current[group], progress } });
    });
    void desktop.modelSetupStatus().then(value => { if (!receivedProgress) update(value); }).catch(() => undefined);
    return () => { mounted = false; unsubscribe(); unsubscribeOptional?.(); };
  }, []);
  useEffect(() => api()?.onExportProgress(event => {
    setExportProgress(event);
    if (['complete', 'error', 'cancelled'].includes(event.phase)) {
      finishedExport.current = event.jobId; setExportJob(undefined); setExportPending(false);
    }
  }), []);
  useEffect(() => {
    if (!plan) return;
    setBgmAsset(plan.bgm.enabled ? plan.bgm.assetId ?? '' : '');
    setBgmVolume(plan.bgm.volume); setBgmDucking(plan.bgm.ducking);
    setNarrationVolume(plan.audio.narrationVolume); setOriginalEnabled(plan.audio.originalEnabled);
    setOriginalVolume(plan.audio.originalVolume); setOriginalDucking(plan.audio.originalDucking);
    setPlaybackRate(plan.output.playbackRate);
  }, [plan?.id]);

  useEffect(() => {
    const desktop = api();
    if (!desktop) return;
    let receivedCompositionProgress = false;
    void desktop.getStatus().then(result => {
      setStatus(result); setEnginePath(result.enginePath ?? ''); setModelDir(result.modelDir ?? '');
    });
    void refreshModelSettings().catch(() => undefined);
    void desktop.listVoices().then(setClonedVoices);
    void desktop.resumeLastProject().then(last => {
      if (!last || receivedCompositionProgress) return;
      setPlan(last.plan); setProjectId(last.plan.id); setScript(last.plan.input.script);
      setAspectRatio(`${last.plan.canvas.width === last.plan.canvas.height ? '1:1' : last.plan.canvas.width > last.plan.canvas.height ? '16:9' : '9:16'}`);
      setCaptionStyle(last.plan.template.captionStyle);
      setCaptionHighlight(last.plan.template.captionHighlight ?? 'word');
      setSourceVideoPath(last.plan.input.sourceVideoPath); setVoiceId(last.plan.narration.voiceId);
      if (last.preview) setPreview(last.preview);
    }).catch(() => undefined);
    return desktop.onCompositionProgress(event => {
      receivedCompositionProgress = true;
      if (jobRef.current && event.jobId !== jobRef.current) return;
      setProgress(event);
      if (event.plan) setPlan(event.plan);
      if (event.preview) { setPreview(event.preview); setPreviewError(undefined); }
      if (event.phase === 'complete') void refreshAssets().catch(() => undefined);
      if (event.phase === 'complete' || event.phase === 'error' || event.phase === 'cancelled') {
        jobRef.current = undefined; setJobId(undefined);
      }
    });
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    // The player package draws an asymmetric play glyph; keep its controls and center the icon.
    const playIcon = player.shadowRoot?.querySelector<SVGSVGElement>('.hfp-play-btn .hfp-ico-play svg');
    playIcon?.setAttribute('viewBox', '0 0 24 24');
    playIcon?.querySelector('path')?.setAttribute('d', 'M7 4.5a1.5 1.5 0 0 1 2.3-1.27l11.25 7.5a1.5 1.5 0 0 1 0 2.54l-11.25 7.5A1.5 1.5 0 0 1 7 19.5v-15Z');
    const speedStyle = document.createElement('style');
    speedStyle.textContent = '.hfp-speed-wrap{display:none}';
    player.shadowRoot?.appendChild(speedStyle);
    const ready = () => { player.playbackRate = 1; setPreviewError(undefined); };
    const failed = (event: Event) => setPreviewError((event as CustomEvent<{ message?: string }>).detail?.message ?? '预览加载失败');
    player.addEventListener('ready', ready); player.addEventListener('error', failed);
    return () => { player.removeEventListener('ready', ready); player.removeEventListener('error', failed); speedStyle.remove(); };
  }, [preview?.entryUrl]);

  const estimatedSeconds = useMemo(() => estimateDuration(script), [script]);
  const working = Boolean(jobId) || exportPending || Boolean(exportJob) || bgmBusy || generatePending || captionBusy;
  const modelsPending = !!modelSetup && !['ready', 'bundled'].includes(modelSetup.state);
  const modelSetupLabel = modelSetup?.state === 'error' ? '模型准备失败' : '正在准备模型';
  const showSetup = modelsPending && !dialog && !candidateSceneId && !cloneOpen &&
    (setupRequested || (active && !setupDismissed && (modelSetup.state !== 'checking' || modelSetup.activity === 'importing')));
  const audioDirty = !!plan && (bgmAsset !== (plan.bgm.enabled ? plan.bgm.assetId ?? '' : '') || bgmVolume !== plan.bgm.volume || bgmDucking !== plan.bgm.ducking ||
    narrationVolume !== plan.audio.narrationVolume || originalEnabled !== plan.audio.originalEnabled ||
    originalVolume !== plan.audio.originalVolume || originalDucking !== plan.audio.originalDucking);
  const contentDirty = !plan || script.trim() !== plan.input.script ||
    voiceId !== plan.narration.voiceId || sourceVideoPath !== plan.input.sourceVideoPath || captionStyle !== plan.template.captionStyle ||
    aspectRatio !== (plan.canvas.width === plan.canvas.height ? '1:1' : plan.canvas.width > plan.canvas.height ? '16:9' : '9:16');
  const compositionDirty = contentDirty || captionHighlight !== (plan?.template.captionHighlight ?? 'word');
  const needsGeneration = compositionDirty || audioDirty || !preview;
  const audioSettings = () => ({
    bgm: { enabled: !!bgmAsset, assetId: bgmAsset || undefined, volume: bgmVolume, ducking: bgmDucking },
    audio: { narrationVolume, originalEnabled: !!sourceVideoPath && originalEnabled, originalVolume, originalDucking }
  });
  const sourceAsset = sourceVideoPath ? assets.find(asset => asset.filePath === sourceVideoPath) : undefined;
  const activeStage = stages.findIndex(stage => stage.phase === progress?.phase);
  const originalVideoDurationMs = plan?.input.sourceVideoPath
    ? assets.find(asset => asset.filePath === plan.input.sourceVideoPath)?.durationMs ??
      Math.max(0, ...plan.scenes.filter(scene => scene.visual.type === 'source').map(scene => scene.visual.sourceOutMs ?? 0))
    : 0;
  const candidateStartIndex = plan?.scenes.findIndex(scene => scene.id === candidateSceneId) ?? -1;
  const compositionRate = plan?.output.playbackRate ?? 1;
  const compositionSeconds = (milliseconds: number) => (milliseconds / compositionRate / 1000).toFixed(1);

  async function generate() {
    const desktop = api();
    if (!desktop) {
      setProgress({ jobId: 'browser', phase: 'error', progress: 0, message: '请在帧舟桌面应用中运行。', recoverable: true });
      return;
    }
    if (modelsPending) return;
    if (plan && preview && !compositionDirty && audioDirty) { await applyAudio(); return; }
    if (status.state === 'missing') { openDialog('settings'); return; }
    setGeneratePending(true);
    setPreviewError(undefined); setPreview(undefined); setPlan(undefined);
    setExportProgress(undefined);
    setProgress({ jobId: 'pending', phase: 'drafting', progress: 0.01, message: '正在创建本地工程…' });
    try {
      const result = await desktop.generateComposition({ script, voiceId, aspectRatio, captionStyle, captionHighlight, sourceVideoPath, language: voiceLanguages[voiceId] ?? 'Chinese', precision: 'int8', ...audioSettings(), playbackRate });
      jobRef.current = result.jobId; setJobId(result.jobId); setProjectId(result.projectId);
    } catch (error) {
      setProgress({ jobId: 'failed', phase: 'error', progress: 0, message: error instanceof Error ? error.message : String(error), recoverable: true });
    } finally { setGeneratePending(false); }
  }

  async function applyCaptions(edits?: Array<{ cueId: string; text: string }>) {
    if (!plan || !api()) return;
    setCaptionBusy(true); setCaptionError('');
    try {
      const result = await api()!.updateCaptions(plan.id, { mode: edits ? 'phrase' : captionHighlight, edits });
      setPlan(result.plan); setPreview(result.preview); setCaptionHighlight(result.plan.template.captionHighlight ?? 'word');
      setCaptionEditor(false); setCaptionEdits({});
    } catch (error) { setCaptionError(error instanceof Error ? error.message : String(error)); }
    finally { setCaptionBusy(false); }
  }

  async function chooseSource() {
    const selected = await api()?.chooseFile('video');
    if (!selected) return;
    try {
      const imported = await api()!.importAsset(selected);
      setSourceVideoPath(imported.filePath); setSourceError('');
      if (imported.hasAudio === false) setOriginalEnabled(false);
      await refreshAssets();
    } catch (error) { setSourceError(error instanceof Error ? error.message : String(error)); }
  }

  async function createClone() {
    if (!cloneName.trim() || !cloneReference) return;
    setCloneBusy(true); setCloneError('');
    try {
      const profile = await api()!.cloneVoice({ name: cloneName.trim(), referenceAudioPath: cloneReference });
      setClonedVoices(items => [...items, profile]); setVoiceId(profile.id); setCloneOpen(false);
      setCloneName(''); setCloneReference('');
    } catch (error) { setCloneError(error instanceof Error ? error.message : String(error)); }
    finally { setCloneBusy(false); }
  }

  async function applyAudio(rate = playbackRate) {
    if (!projectId) return;
    setBgmBusy(true);
    try {
      const result = await api()!.updateAudio(projectId, { ...audioSettings(), playbackRate: rate });
      setPlaybackRate(rate);
      setPlan(result.plan); setPreview(result.preview); setPreviewError(undefined); setExportProgress(undefined);
    } catch (error) { setPreviewError(error instanceof Error ? error.message : String(error)); }
    finally { setBgmBusy(false); }
  }
  async function exportVideo(draft?: PublishDraft) {
    if (!projectId || needsGeneration) return;
    setExportPending(true); setExportProgress(undefined);
    try {
      const result = await api()!.exportVideo(projectId, draft);
      if (result && result.jobId !== finishedExport.current) setExportJob(result.jobId);
    }
    catch (error) { setExportProgress({ jobId: '', phase: 'error', progress: 0, message: error instanceof Error ? error.message : String(error) }); }
    finally { setExportPending(false); }
  }

  async function exportArtifact(kind: 'narration-mp3' | 'mixed-mp3' | 'srt' | 'ass') {
    if (!projectId) return;
    setExportPending(true); setExportProgress(undefined);
    try {
      const result = await api()!.exportArtifact(projectId, kind);
      if (result) setExportProgress({ jobId: '', phase: 'complete', progress: 1, message: '文件已导出', outputPath: result.outputPath });
    } catch (error) { setExportProgress({ jobId: '', phase: 'error', progress: 0, message: error instanceof Error ? error.message : String(error) }); }
    finally { setExportPending(false); }
  }

  async function replaceScene(sceneId: string, choice: SceneChoice) {
    if (!projectId) return;
    setReplacingScene(sceneId);
    try {
      const result = await api()!.replaceScene(projectId, sceneId, choice);
      if (result.status === 'unavailable') throw new Error(result.message);
      setPlan(result.plan);
      setPreview(result.preview);
      setPreviewError(undefined);
      setExportProgress(undefined);
      setCandidateSceneId(undefined);
    } finally { setReplacingScene(undefined); }
  }

  async function configure() {
    setEngineNotice('');
    try {
      const next = await api()?.configure({ enginePath, modelDir });
      if (next) { setStatus(next); setEngineNotice(next.message); }
    } catch (error) { setEngineNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function importLocalModels() {
    setModelImportPending(true);
    setModelImportError('');
    setModelImportNotice('');
    try {
      if (await api()?.importLocalModels() && !modelsPending) setModelImportNotice('已选好文件夹。准备其他功能时，会先复用这里的模型。');
    }
    catch (error) { setModelImportError(error instanceof Error ? error.message : String(error)); }
    finally { setModelImportPending(false); }
  }

  async function configureSemantic(enginePath = semanticEnginePath, modelPath = semanticModelPath) {
    setSemanticNotice('');
    try {
      const result = await api()!.configureSemantic({ enginePath, modelPath });
      setSemanticEnginePath(result.enginePath); setSemanticModelPath(result.modelPath);
      setSemanticConfigured(result.configured);
      void api()?.optionalModelStatus?.().then(setOptionalModels).catch(() => undefined);
      setSemanticNotice(result.configured ? '已启用按意思搜索。' : '已切换到关键词搜索。');
    } catch (error) { setSemanticNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function configureSceneModel(modelPath = sceneModelPath) {
    setSceneModelNotice('');
    try {
      const result = await api()!.configureSceneModel(modelPath);
      setSceneModelPath(result.modelPath);
      setSceneConfigured(result.configured);
      setSourceAnalysisReady(result.canAnalyzeSource);
      void api()?.optionalModelStatus?.().then(setOptionalModels).catch(() => undefined);
      setSceneModelNotice(result.configured ? '已启用智能分镜。' : '已切换到关键词匹配。');
    } catch (error) { setSceneModelNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function prepareOptionalModel(group: OptionalModel) {
    const desktop = api();
    if (!desktop?.prepareOptionalModel) return;
    setOptionalRequests(current => ({ ...current, [group]: true }));
    setOptionalErrors(current => ({ ...current, [group]: undefined }));
    if (group === 'scene') setSceneModelNotice('');
    if (group === 'search') setSemanticNotice('');
    try {
      await desktop.prepareOptionalModel(group);
      await refreshModelSettings();
    } catch (error) {
      setOptionalErrors(current => ({ ...current, [group]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setOptionalRequests(current => ({ ...current, [group]: false }));
    }
  }

  function optionalModelAction(group: OptionalModel, enabled: boolean) {
    const model = optionalModels?.[group];
    if (!model) return null;
    const progress = model.progress;
    const pending = optionalRequests[group];
    if (progress && ['checking', 'downloading'].includes(progress.state)) return <ModelProgress status={progress}/>;
    const failure = !model.installed && progress?.state === 'error';
    return <>
      {failure && <ModelProgress status={progress}/>}
      {optionalErrors[group] && !failure && <p className="field-error" role="alert">{optionalErrors[group]}</p>}
      {!enabled && (model.downloadable || model.installed) && <div className="model-actions">
        <button className="secondary-button" disabled={pending} onClick={() => void prepareOptionalModel(group)}>
          {!pending && !model.installed && <Download size={15}/>}
          {pending ? '正在准备…' : model.installed ? '启用' : failure ? '重试下载' : `${group === 'clone' ? '下载' : '下载并启用'} · ${modelSizes[group]}`}
        </button>
      </div>}
    </>;
  }

  function closeSetup() { setSetupDismissed(true); setSetupRequested(false); }
  function retryBasicModels() { setModelImportError(''); void api()?.retryModelSetup(); }
  function openOnlineLibrary() {
    closeSetup(); setCandidateSceneId(undefined); openDialog('online');
  }

  return <div className="app-shell">
    {modelsPending && <section className="model-setup" aria-label="准备创作模型">
      <span>{modelSetup.state === 'error' ? '配音和字幕准备失败' : '正在准备配音和字幕，你可以先写文案。'}</span>
      <button className="text-action" onClick={() => setSetupRequested(true)}>查看进度</button>
    </section>}

    <main className={`creator-layout ${plan ? 'has-storyboard' : ''}`}>
      <section className="create-pane" aria-labelledby="create-title">
        <div className="pane-heading"><span>AUTO COMPOSITION</span><h1 id="create-title">一段文案，自动成为一条片。</h1><p>旁白是真实时钟。字幕、画面和素材会跟着声音重新排好。</p></div>

        <label className="script-field">
          <span>视频文案</span>
          <textarea value={script} maxLength={8000} onChange={event => setScript(event.target.value)} placeholder="输入推广文案或观点内容…" disabled={working}/>
          <small><b>约 {estimatedSeconds || '—'} 秒</b>{script.length.toLocaleString()} / 8,000</small>
        </label>

        <div className="source-card">
          <div className="source-copy"><span className="source-icon"><Video size={18}/></span><div><b>原始视频</b><small>可选；不添加也能用素材与动效完成视频</small></div></div>
          {sourceVideoPath ? <div className="source-selected"><span title={sourceVideoPath}>{sourceVideoPath.split(/[\\/]/u).at(-1)}</span><button aria-label="移除原始视频" onClick={() => { setSourceVideoPath(undefined); setOriginalEnabled(false); }} disabled={working}><X size={15}/></button></div>
            : <button className="secondary-button" onClick={chooseSource} disabled={working}><Upload size={15}/> 添加视频</button>}
        </div>
        {sourceError && <p className="field-error" role="alert">原始视频入库失败：{sourceError}</p>}
        {sourceVideoPath && <div className="source-model-prompt">
          <p className="candidate-message">{sourceAnalysisReady ? '应用会根据旁白，从原片画面和原声中挑选合适片段。' : '想从原片里自动挑片段？启用智能选段。'}</p>
          {!sourceAnalysisReady && (optionalModels?.scene.downloadable || optionalModels?.scene.installed
            ? optionalModelAction('scene', false)
            : <button className="text-action" onClick={() => openDialog('settings')}>查看创作设置</button>)}
        </div>}

        <button className="more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><Settings2 size={15}/> 更多设置{plan && preview ? ' · 音轨' : ''} <ChevronDown size={15}/></button>
        {moreOpen && <div className="settings-grid">
          <label><span>音色</span><select disabled={working} value={voiceId} onChange={event => setVoiceId(event.target.value)}>
            <optgroup label="内置音色">{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.note}</option>)}</optgroup>
            {!!clonedVoices.length && <optgroup label="我的克隆音色">{clonedVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</optgroup>}
          </select><button type="button" className="text-action" disabled={modelsPending} onClick={() => setCloneOpen(true)}>克隆新音色</button></label>
          <label><span>画幅</span><select disabled={working} value={aspectRatio} onChange={event => setAspectRatio(event.target.value as typeof aspectRatio)}><option>9:16</option><option>16:9</option><option>1:1</option></select></label>
          <label><span>字幕风格</span><select disabled={working} value={captionStyle} onChange={event => setCaptionStyle(event.target.value as typeof captionStyle)}><option value="commerce-bold">电商强调</option><option value="opinion-clean">观点口播</option><option value="brand-minimal">品牌极简</option><option value="info-card">信息卡片</option></select></label>
          <label><span>字幕高亮</span><select aria-label="字幕高亮粒度" disabled={working} value={captionHighlight} onChange={event => setCaptionHighlight(event.target.value as typeof captionHighlight)}><option value="none">无动态高亮</option><option value="word">按词高亮</option><option value="phrase">按短语高亮</option></select></label>
          {plan && preview && <div className="bgm-controls">
            <b>音轨</b>
            <label>旁白音量 {Math.round(narrationVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={narrationVolume} disabled={working} onChange={event => setNarrationVolume(Number(event.target.value))}/></label>
            {plan.input.sourceVideoPath && <>
              <label><input type="checkbox" checked={originalEnabled} disabled={working || sourceAsset?.hasAudio === false} onChange={event => setOriginalEnabled(event.target.checked)}/> 保留原视频声音</label>
              {sourceAsset?.hasAudio === false ? <small>原视频没有音轨。</small> : <small>原声随选中的原片段剪辑；更换画面时保留这条原声音轨。</small>}
              {originalEnabled && <><label>原声音量 {Math.round(originalVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={originalVolume} disabled={working} onChange={event => setOriginalVolume(Number(event.target.value))}/></label><label><input type="checkbox" checked={originalDucking} disabled={working} onChange={event => setOriginalDucking(event.target.checked)}/> 旁白说话时降低原声音量</label></>}
            </>}
            <label>背景音乐<select disabled={working} value={bgmAsset} onChange={event => setBgmAsset(event.target.value)}><option value="">不添加配乐</option>{assets.filter(asset => asset.type === 'audio').map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><button onClick={() => openDialog('audio')}>导入 BGM</button></label>
            {!assets.some(asset => asset.type === 'audio') && <small>素材库中还没有音频，导入 BGM 后即可选择配乐。</small>}
            {bgmAsset && <><label>配乐音量 {Math.round(bgmVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={bgmVolume} disabled={working} onChange={event => setBgmVolume(Number(event.target.value))}/></label><label><input type="checkbox" checked={bgmDucking} disabled={working} onChange={event => setBgmDucking(event.target.checked)}/> 旁白说话时降低配乐音量</label></>}
          </div>}
        </div>}

        <div className="primary-row">
          {jobId && <button className="cancel-button" onClick={() => api()?.cancelComposition(jobId)}><Square size={14} fill="currentColor"/> 取消生成</button>}
          <button className={`generate-button ${needsGeneration ? 'needs-generation' : 'up-to-date'}`} disabled={working || modelsPending || !script.trim()} onClick={() => void generate()}><WandSparkles size={18}/>{modelsPending ? modelSetupLabel : jobId || generatePending ? '正在自动成片…' : exportJob || exportPending ? '正在导出…' : bgmBusy ? '正在应用音轨…' : progress?.phase === 'error' || progress?.phase === 'cancelled' ? '重新生成' : '生成视频'}</button>
        </div>
      </section>

      <section className="preview-pane" aria-labelledby="preview-title">
        <div className="preview-heading"><div><span>PREVIEW</span><h2 id="preview-title">成片预览</h2></div>{plan && <span className="revision">R{plan.revision} · {plan.scenes.length} 个分镜</span>}</div>
        <div className={`preview-stage ${preview ? 'ready' : ''}`} style={preview ? { aspectRatio: `${preview.width}/${preview.height}` } : undefined}>
          {preview ? <hyperframes-player key={preview.entryUrl} ref={playerRef} src={preview.entryUrl} width={preview.width} height={preview.height} controls/>
            : <div className="empty-preview"><span><Film size={29}/></span><h3>{working ? '正在编织画面' : '等待第一条成片'}</h3><p>{working ? '旁白生成后，画面与字幕会出现在这里。' : '输入文案即可开始；原始视频不是必填项。'}</p></div>}
        </div>
        {previewError && <div className="preview-error" role="alert"><span>{previewError}</span><button onClick={() => setPreview(value => value ? { ...value, entryUrl: `${value.entryUrl}?retry=${Date.now()}` } : value)}><RefreshCw size={14}/> 重试加载</button></div>}

        {progress && <div className={`job-status ${progress.phase}`} role="status" aria-live="polite">
          <div className="status-line"><span className="status-symbol">{working ? <Activity size={18}/> : progress.phase === 'complete' ? <Check size={18}/> : progress.phase === 'error' ? <X size={18}/> : <Sparkles size={18}/>}</span><div><b>{progress.message}</b><small>{Math.round(progress.progress * 100)}% · 工程会随阶段自动保存</small></div></div>
          <div className="progress-track"><span style={{ width: `${Math.max(2, progress.progress * 100)}%` }}/></div>
          <ol className="stage-list">{stages.map((stage, index) => <li key={stage.phase} className={index < activeStage || progress.phase === 'complete' ? 'done' : index === activeStage ? 'active' : ''}>{stage.label}</li>)}</ol>
        </div>}

        {plan && preview && <label className="preview-speed">成片倍速
          <select aria-label="成片倍速" value={playbackRate} disabled={working || !!replacingScene || compositionDirty} onChange={event => void applyAudio(Number(event.target.value))}>
            {[.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
          </select><small>预览及导出使用相同倍速 · 约 {((preview.durationMs) / 1000).toFixed(1)} 秒</small>
        </label>}
        {plan?.warnings?.length ? <div className="candidate-message" role="status">{plan.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</div> : null}
        {plan && preview && <div className="export-controls">
          <div className="caption-controls"><span>字幕高亮：{captionHighlight === 'phrase' ? '按短语' : captionHighlight === 'word' ? '按词' : '关闭'}</span>
            <button disabled={working || !!replacingScene || contentDirty} onClick={() => void applyCaptions()}>更新字幕高亮</button>
            <button disabled={working || !!replacingScene || contentDirty} onClick={() => { setCaptionEditor(true); setCaptionError(''); setCaptionEdits({}); }}>编辑字幕分组</button>
            <small>更新字幕无需重新生成旁白</small>
          </div>
          {captionError && !captionEditor && <p className="field-error" role="alert">{captionError}</p>}
          <div className="export-actions" role="group" aria-label="导出文件">
            <button className="export-primary" disabled={working || !!replacingScene || needsGeneration} onClick={() => void exportVideo()}>{exportJob ? '正在导出…' : '导出 MP4'}</button>
            <button aria-label="导出旁白 MP3" title="导出旁白 MP3" disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('narration-mp3')}>旁白 MP3</button>
            <button aria-label="导出混音 MP3" title="导出混音 MP3" disabled={working || !!replacingScene || needsGeneration} onClick={() => void exportArtifact('mixed-mp3')}>混音 MP3</button>
            <button aria-label="导出 SRT" title="导出 SRT" disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('srt')}>SRT</button>
            <button aria-label="导出 ASS" title="导出 ASS" disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('ass')}>ASS</button>
          </div>
          {(exportJob || exportProgress) && <div className="export-progress">
            <div className="export-progress-header">
              {exportProgress && <span role={exportProgress.phase === 'error' ? 'alert' : 'status'}>{exportProgress.message}</span>}
              {exportJob && <button onClick={() => api()?.cancelExport(exportJob)}>取消导出</button>}
              {exportProgress?.outputPath && <button onClick={() => api()?.reveal(exportProgress.outputPath!)}>打开成品所在文件夹</button>}
            </div>
            {exportJob && <progress max="1" value={exportProgress?.progress}/>}
          </div>}
          <PublishPanel key={plan.id} title={plan.scenes[0]?.script} evidence={plan.captions.map(cue => cue.text).join('\n') || plan.input.script}
            durationMs={preview.durationMs} width={preview.width} height={preview.height} disabled={working || !!replacingScene || needsGeneration}
            playhead={() => playerRef.current?.currentTime} applyAspect={setAspectRatio} onExport={draft => void exportVideo(draft)}/>
          {needsGeneration && <small>设置已修改，点击高亮的“生成视频”更新成片。</small>}
        </div>}
      </section>
      {plan && <aside className="storyboard" aria-label="分镜列表">
        <div className="storyboard-title"><span>分镜卡片</span></div>
        <div className="scene-list">{plan.scenes.map((scene, index) => <article key={scene.id} className="scene-card">
          <span className="scene-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="scene-type">{scene.visual.type === 'kinetic-text' ? <Sparkles size={14}/> : scene.visual.type === 'image' ? <Image size={14}/> : <Video size={14}/>}</span>
          <div><b>{scene.script}</b><small>成片 {compositionSeconds(scene.startMs)}–{compositionSeconds(scene.endMs)} 秒 · {scene.visual.type === 'source' ? `原视频 ${((scene.visual.sourceInMs ?? 0) / 1000).toFixed(1)}–${((scene.visual.sourceOutMs ?? 0) / 1000).toFixed(1)} 秒` : scene.visual.type === 'kinetic-text' && originalVideoDurationMs && scene.startMs >= originalVideoDurationMs ? '原视频结束后的补画面' : scene.visual.type}{index > 0 && scene.visual.assetId && scene.visual.assetId === plan.scenes[index - 1].visual.assetId &&
            (scene.visual.type === 'image' || scene.visual.sourceInMs === plan.scenes[index - 1].visual.sourceOutMs) ? ' · 延续上一画面' : ''}</small>{scene.visual.type === 'source' && scene.visual.sourceMatch && <small title={scene.visual.sourceMatch.reason}>选段依据：{scene.visual.sourceMatch.reason}</small>}</div>
          <button onClick={() => setCandidateSceneId(scene.id)} disabled={working || Boolean(replacingScene)}><RefreshCw size={14}/> 换画面</button>
        </article>)}</div>
      </aside>}
    </main>

    {captionEditor && plan && <Modal title="编辑字幕分组" subtitle="用 | 分隔一起高亮的文字，例如：只要|三个步骤。保存后使用短语高亮。" close={() => { if (!captionBusy) setCaptionEditor(false); }} wide>
      <div className="caption-editor">{plan.captions.map(cue => <label key={cue.id}>
        <span>{compositionSeconds(cue.startMs)}–{compositionSeconds(cue.endMs)} 秒</span>
        <textarea rows={2} disabled={captionBusy || cue.text.includes('|')} value={captionEdits[cue.id] ?? captionAnnotation(cue)}
          onChange={event => setCaptionEdits(current => ({ ...current, [cue.id]: event.target.value }))}/>
        {cue.text.includes('|') && <small>这条字幕含 |，使用自动分组。</small>}
      </label>)}</div>
      {captionError && <p className="field-error" role="alert">{captionError}</p>}
      <button className="modal-primary" disabled={captionBusy} onClick={() => void applyCaptions(plan.captions.filter(cue => !cue.text.includes('|')).map(cue => ({ cueId: cue.id, text: captionEdits[cue.id] ?? captionAnnotation(cue) })))}>{captionBusy ? '正在更新字幕…' : '保存分组并更新预览'}</button>
    </Modal>}

    {candidateSceneId && plan && projectId && candidateStartIndex >= 0 && <ScenePicker key={`${projectId}-${candidateSceneId}`}
      projectId={projectId} scenes={plan.scenes.slice(candidateStartIndex, candidateStartIndex + 10)}
      playbackRate={compositionRate} onClose={() => setCandidateSceneId(undefined)}
      onOpenOnlineSettings={() => { setCandidateSceneId(undefined); openDialog('settings'); }} onAssetsChanged={refreshAssets}
      onApply={choice => replaceScene(candidateSceneId, choice)}/>}

    {cloneOpen && <Modal title="克隆音色" subtitle="用一段参考录音制作自己的旁白音色。" close={() => !cloneBusy && setCloneOpen(false)}>
      {optionalModels && !optionalModels.clone.installed ? <div className="settings-form">
        <p>{optionalModels.clone.downloadable ? '首次使用需准备音色克隆，下载完成后就可以选择录音。' : '当前版本缺少音色克隆所需的模型。'}</p>
        {optionalModelAction('clone', false)}
      </div> : <div className="settings-form">
        <label className="clone-field">音色名称<input value={cloneName} maxLength={60} onChange={event => setCloneName(event.target.value)} placeholder="例如：我的旁白"/></label>
        <label className="clone-field">参考音频<div><input readOnly value={cloneReference} placeholder="建议 5–20 秒清晰单人语音"/><button onClick={async () => { const selected = await api()?.chooseFile('audio'); if (selected) setCloneReference(selected); }}>选择音频</button></div></label>
        {cloneError && <p className="field-error" role="alert">{cloneError}</p>}
        <button className="modal-primary" disabled={cloneBusy || !cloneName.trim() || !cloneReference} onClick={createClone}>{cloneBusy ? '正在克隆…' : '创建并使用音色'}</button>
      </div>}
    </Modal>}

    {libraryView && <Modal title="素材库" subtitle={libraryView === 'audio' ? '导入音频后，回到背景音乐下拉框选择配乐' : '整理画面、图片与声音，两种创作模式都可以使用。'} close={() => openDialog()} wide workspace>
      <LibraryPanel initialTab={libraryView === 'online' ? 'online' : undefined} initialType={libraryView === 'audio' ? 'audio' : undefined} changed={refreshAssets} onOnlineSettings={() => openDialog('settings')}
        useBgm={active && plan && preview && !working ? asset => { setBgmAsset(asset.id); openDialog(); } : undefined}/>
    </Modal>}

    {showSetup && <Modal title="准备配音和字幕" subtitle="基础模型约占 4.8 GB，下载可断点续传。" close={closeSetup} className="creation-settings" workspace>
      <div className="settings-form">
        <ModelProgress status={modelSetup}/>
        {modelImportError && <p className="field-error" role="alert">{modelImportError}</p>}
        <div className="model-actions">
          {modelSetup.state === 'error' && <button className="modal-primary" disabled={modelImportPending} onClick={retryBasicModels}><RefreshCw size={15}/> 重试下载</button>}
          <button className={modelSetup.state === 'error' ? 'secondary-button' : 'modal-primary'} onClick={closeSetup}>{modelSetup.state === 'error' ? '返回创作' : '后台继续'}</button>
          <button className="secondary-button" disabled={modelImportPending} onClick={() => void importLocalModels()}><FolderOpen size={15}/> 导入已有模型</button>
        </div>
        <p>缺画面时，可在素材库用 <button className="text-action" onClick={openOnlineLibrary}>在线素材</button> 补充。</p>
      </div>
    </Modal>}

    {settingsOpen && <Modal title="创作设置" subtitle="配音、字幕和智能选段都在本机处理。" close={() => openDialog()} className="creation-settings" workspace>
      <div className="settings-form">
        <Feature title="自动配音和字幕" description="把文案读成旁白，让字幕跟着声音走。"
          status={modelsPending ? modelSetupLabel : status.state === 'idle' ? '已就绪' : '待配置'} ready={!modelsPending && status.state === 'idle'}>
          {modelsPending && <div className="model-actions">
            <button className="secondary-button" onClick={() => { openDialog(); setSetupRequested(true); }}>查看进度</button>
          </div>}
        </Feature>
        <Feature title="智能分镜和原片选段" description="根据文案规划画面，有原片时自动找合适的片段。"
          status={sourceAnalysisReady ? '已启用' : sceneConfigured ? '仅文案分镜' : optionalModels?.scene.installed ? '已关闭' : '可选'} ready={sourceAnalysisReady}>
          {optionalModelAction('scene', sourceAnalysisReady)}
        </Feature>
        <Feature title="按意思找本地素材" description="换画面时，搜「上班路上」也能找到标着「通勤」的片段。"
          status={semanticConfigured ? '已启用' : optionalModels?.search.installed ? '已关闭' : '可选'} ready={semanticConfigured}>
          {optionalModelAction('search', semanticConfigured)}
        </Feature>
        <Feature title="克隆自己的声音" description="用一段参考录音制作专属旁白音色。"
          status={optionalModels?.clone.installed ? '已就绪' : '可选'} ready={optionalModels?.clone.installed}>
          {optionalModelAction('clone', Boolean(optionalModels?.clone.installed))}
        </Feature>
        <Feature title="在线补画面" description="本地素材不足时，按下方顺序搜索符合条件的在线来源。"
          status="支持无 Key 搜索" ready>
          <OnlineSourceSettings/>
        </Feature>
        {modelSetup && modelSetup.state !== 'bundled' && <div>
          <button className="text-action" disabled={modelImportPending} onClick={() => void importLocalModels()}>导入已有模型</button>
          {modelImportError && <p className="field-error" role="alert">{modelImportError}</p>}
          {modelImportNotice && <p role="status">{modelImportNotice}</p>}
        </div>}
        <details className="advanced-settings">
          <summary>高级设置 · 手动指定模型</summary>
          <div className="settings-form">
            <PathField label="旁白引擎文件" value={enginePath} placeholder="qwen_tts.exe 或 WSL 可执行文件" choose={async () => { const selected = await api()?.chooseFile('engine'); if (selected) setEnginePath(selected); }}/>
            <PathField label="旁白模型目录" value={modelDir} placeholder="qwen3-tts-1.7b-customvoice" choose={async () => { const selected = await api()?.chooseFile('model'); if (selected) setModelDir(selected); }}/>
            <p role="status">{engineNotice || (modelsPending ? modelSetupLabel : status.message)}</p>
            <div className="model-actions"><button className="secondary-button" onClick={configure}>保存并检测旁白</button></div>
            <PathField label="分镜模型文件" value={sceneModelPath} placeholder="选择本地 .gguf 模型文件" choose={async () => { const selected = await api()?.chooseFile('scene-model'); if (selected) setSceneModelPath(selected); }}/>
            {sceneModelNotice && <p role="status">{sceneModelNotice}</p>}
            <div className="model-actions">
              <button className="secondary-button" disabled={!sceneModelPath || working || optionalRequests.scene} onClick={() => void configureSceneModel()}>保存分镜模型</button>
              {sceneConfigured && <button className="text-action" disabled={working || optionalRequests.scene} onClick={() => void configureSceneModel('')}>关闭智能分镜</button>}
            </div>
            <PathField label="本地搜索运行程序" value={semanticEnginePath} placeholder="选择 llama-server.exe" choose={async () => { const selected = await api()?.chooseFile('semantic-engine'); if (selected) setSemanticEnginePath(selected); }}/>
            <PathField label="本地搜索模型文件" value={semanticModelPath} placeholder="选择本地 .gguf 模型文件" choose={async () => { const selected = await api()?.chooseFile('semantic-model'); if (selected) setSemanticModelPath(selected); }}/>
            {semanticNotice && <p role="status">{semanticNotice}</p>}
            <div className="model-actions">
              <button className="secondary-button" disabled={!semanticEnginePath || !semanticModelPath || optionalRequests.search} onClick={() => void configureSemantic()}>保存搜索模型</button>
              {semanticConfigured && <button className="text-action" disabled={optionalRequests.search} onClick={() => void configureSemantic('', '')}>切回关键词搜索</button>}
            </div>
          </div>
        </details>
      </div>
    </Modal>}
  </div>;
}

function Feature({ title, description, status, ready, children }: {
  title: string; description: string; status: string; ready?: boolean; children?: React.ReactNode;
}) {
  return <section className="creation-feature">
    <header><h3>{title}</h3><span className={ready ? 'feature-ready' : undefined}>{status}</span></header>
    <p>{description}</p>
    {children}
  </section>;
}

function PathField({ label, value, placeholder, choose }: { label: string; value: string; placeholder: string; choose: () => void }) {
  return <label className="path-field"><span>{label}</span><div><input readOnly value={value} placeholder={placeholder}/><button onClick={choose}><FolderOpen size={15}/> 浏览</button></div></label>;
}
