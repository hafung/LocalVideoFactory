import '@hyperframes/player';
import './library.css';
import { LibraryPanel } from './LibraryPanel';
import type { HyperframesPlayer } from '@hyperframes/player';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AudioLines, Check, ChevronDown, Film, FolderOpen, Image, Library,
  Play, Plus, RefreshCw, Settings2, Sparkles, Square, Upload, Video, WandSparkles, X
} from 'lucide-react';
import { estimateDuration } from '../shared/markup';
import type { EditPlan } from '../shared/edit-plan';
import type { MediaAsset, OnlineAsset } from '../shared/library';
import type { SceneCandidate, SceneCandidateResult, SceneChoice } from '../shared/scene-candidates';
import type { CompositionProgressEvent, EngineStatus, GenerateCompositionRequest, ExportProgress, VoiceProfile } from '../shared/types';
import type { ModelSetupStatus } from '../shared/model-downloads';

const api = () => window.voxweave;
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

export function App() {
  const [script, setScript] = useState('产品很好，却一直卖不出去？问题也许不在产品，而在表达。让声织帮你把文案、旁白和画面，自动编成一条完整视频。');
  const [visualBrief, setVisualBrief] = useState('');
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
  const [sourceVideoPath, setSourceVideoPath] = useState<string>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
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
  const [enginePath, setEnginePath] = useState('');
  const [modelDir, setModelDir] = useState('');
  const [semanticEnginePath, setSemanticEnginePath] = useState('');
  const [semanticModelPath, setSemanticModelPath] = useState('');
  const [semanticNotice, setSemanticNotice] = useState('');
  const [jobId, setJobId] = useState<string>();
  const jobRef = useRef<string | undefined>(undefined);
  const [projectId, setProjectId] = useState<string>();
  const [progress, setProgress] = useState<CompositionProgressEvent>();
  const [plan, setPlan] = useState<EditPlan>();
  const [preview, setPreview] = useState<Preview>();
  const [previewError, setPreviewError] = useState<string>();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [replacingScene, setReplacingScene] = useState<string>();
  const [sceneNotice, setSceneNotice] = useState<{ sceneId: string; message: string }>();
  const [candidateSceneId, setCandidateSceneId] = useState<string>();
  const [candidateResult, setCandidateResult] = useState<SceneCandidateResult>();
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidateThroughSceneId, setCandidateThroughSceneId] = useState<string>();
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState('');
  const [candidatePreview, setCandidatePreview] = useState<SceneCandidate>();
  const [onlineCandidates, setOnlineCandidates] = useState<OnlineAsset[]>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [onlineQuery, setOnlineQuery] = useState('');
  const [downloadingOnlineId, setDownloadingOnlineId] = useState<string>();
  const candidateSearchToken = useRef(0);
  const playerRef = useRef<HyperframesPlayer>(null);
  useEffect(() => {
    const desktop = api();
    if (!desktop?.modelSetupStatus) return;
    let active = true;
    const update = (value: ModelSetupStatus) => {
      if (!active) return;
      setModelSetup(value);
      if (value.state === 'ready') {
        void desktop.getStatus().then(result => { if (active) { setStatus(result); setEnginePath(result.enginePath ?? ''); setModelDir(result.modelDir ?? ''); } });
        void desktop.semanticStatus().then(result => { if (active) { setSemanticEnginePath(result.enginePath); setSemanticModelPath(result.modelPath); } });
      }
    };
    const unsubscribe = desktop.onModelSetupProgress(update);
    void desktop.modelSetupStatus().then(update);
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => api()?.onExportProgress(event => {
    setExportProgress(event);
    if (['complete', 'error', 'cancelled'].includes(event.phase)) { setExportJob(undefined); setExportPending(false); }
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
    void desktop.semanticStatus().then(result => { setSemanticEnginePath(result.enginePath); setSemanticModelPath(result.modelPath); }).catch(() => undefined);
    void desktop.listAssets().then(setAssets);
    void desktop.listVoices().then(setClonedVoices);
    void desktop.resumeLastProject().then(last => {
      if (!last || receivedCompositionProgress) return;
      setPlan(last.plan); setProjectId(last.plan.id); setScript(last.plan.input.script);
      setVisualBrief(last.plan.input.visualBrief ?? '');
      setAspectRatio(`${last.plan.canvas.width === last.plan.canvas.height ? '1:1' : last.plan.canvas.width > last.plan.canvas.height ? '16:9' : '9:16'}`);
      setCaptionStyle(last.plan.template.captionStyle);
      setSourceVideoPath(last.plan.input.sourceVideoPath); setVoiceId(last.plan.narration.voiceId);
      if (last.preview) setPreview(last.preview);
    }).catch(() => undefined);
    return desktop.onCompositionProgress(event => {
      receivedCompositionProgress = true;
      if (jobRef.current && event.jobId !== jobRef.current) return;
      setProgress(event);
      if (event.plan) setPlan(event.plan);
      if (event.preview) { setPreview(event.preview); setPreviewError(undefined); }
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
  const working = Boolean(jobId) || exportPending || Boolean(exportJob) || bgmBusy || generatePending;
  const modelsPending = !!modelSetup && !['ready', 'bundled'].includes(modelSetup.state);
  const audioDirty = !!plan && (bgmAsset !== (plan.bgm.enabled ? plan.bgm.assetId ?? '' : '') || bgmVolume !== plan.bgm.volume || bgmDucking !== plan.bgm.ducking ||
    narrationVolume !== plan.audio.narrationVolume || originalEnabled !== plan.audio.originalEnabled ||
    originalVolume !== plan.audio.originalVolume || originalDucking !== plan.audio.originalDucking);
  const compositionDirty = !plan || script.trim() !== plan.input.script || visualBrief.trim() !== (plan.input.visualBrief ?? '') ||
    voiceId !== plan.narration.voiceId || sourceVideoPath !== plan.input.sourceVideoPath || captionStyle !== plan.template.captionStyle ||
    aspectRatio !== (plan.canvas.width === plan.canvas.height ? '1:1' : plan.canvas.width > plan.canvas.height ? '16:9' : '9:16');
  const needsGeneration = compositionDirty || audioDirty || !preview;
  const audioSettings = () => ({
    bgm: { enabled: !!bgmAsset, assetId: bgmAsset || undefined, volume: bgmVolume, ducking: bgmDucking },
    audio: { narrationVolume, originalEnabled: !!sourceVideoPath && originalEnabled, originalVolume, originalDucking }
  });
  const sourceAsset = plan?.input.sourceVideoPath ? assets.find(asset => asset.filePath === plan.input.sourceVideoPath) : undefined;
  const activeStage = stages.findIndex(stage => stage.phase === progress?.phase);
  const originalVideoDurationMs = plan?.input.sourceVideoPath
    ? assets.find(asset => asset.filePath === plan.input.sourceVideoPath)?.durationMs ??
      Math.max(0, ...plan.scenes.filter(scene => scene.visual.type === 'source').map(scene => scene.visual.sourceOutMs ?? 0))
    : 0;
  const candidateStartIndex = plan?.scenes.findIndex(scene => scene.id === candidateSceneId) ?? -1;
  const candidateEndIndex = candidateThroughSceneId && plan ? plan.scenes.findIndex(scene => scene.id === candidateThroughSceneId) : candidateStartIndex;
  const candidateDurationMs = plan && candidateStartIndex >= 0 && candidateEndIndex >= candidateStartIndex
    ? plan.scenes[candidateEndIndex].endMs - plan.scenes[candidateStartIndex].startMs : 0;
  const compositionRate = plan?.output.playbackRate ?? 1;
  const compositionSeconds = (milliseconds: number) => (milliseconds / compositionRate / 1000).toFixed(1);

  async function generate() {
    const desktop = api();
    if (!desktop) {
      setProgress({ jobId: 'browser', phase: 'error', progress: 0, message: '请在 VoxWeave 桌面应用中运行。', recoverable: true });
      return;
    }
    if (modelsPending) return;
    if (plan && preview && !compositionDirty && audioDirty) { await applyAudio(); return; }
    if (status.state === 'missing') { setSettingsOpen(true); return; }
    setGeneratePending(true);
    setPreviewError(undefined); setPreview(undefined); setPlan(undefined);
    setExportProgress(undefined);
    setProgress({ jobId: 'pending', phase: 'drafting', progress: 0.01, message: '正在创建本地工程…' });
    try {
      const result = await desktop.generateComposition({ script, visualBrief, voiceId, aspectRatio, captionStyle, sourceVideoPath, language: voiceLanguages[voiceId] ?? 'Chinese', precision: 'int8', ...audioSettings(), playbackRate });
      jobRef.current = result.jobId; setJobId(result.jobId); setProjectId(result.projectId);
    } catch (error) {
      setProgress({ jobId: 'failed', phase: 'error', progress: 0, message: error instanceof Error ? error.message : String(error), recoverable: true });
    } finally { setGeneratePending(false); }
  }

  async function chooseSource() {
    const selected = await api()?.chooseFile('video');
    if (!selected) return;
    try {
      const imported = await api()!.importAsset(selected);
      setSourceVideoPath(imported.filePath); setSourceError('');
      if (imported.hasAudio === false) setOriginalEnabled(false);
      setAssets(await api()!.listAssets());
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
  async function exportVideo() {
    if (!projectId || needsGeneration) return;
    setExportPending(true); setExportProgress(undefined);
    try { const result = await api()!.exportVideo(projectId); if (result) setExportJob(result.jobId); }
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

  async function loadOnlineCandidates(query: string, sceneId: string, throughSceneId: string | undefined, token: number) {
    setOnlineCandidates([]); setOnlineError(''); setOnlineQuery('');
    if (!query.trim()) { setOnlineLoading(false); return; }
    setOnlineLoading(true);
    try {
      const desktop = api()!;
      const status = await desktop.pexelsStatus();
      if (token !== candidateSearchToken.current) return;
      if (!status.configured) { setOnlineError('配置 Pexels API Key 后，可在这里同时查找视频和图片。'); return; }
      const orientation = plan?.scenes.find(scene => scene.id === sceneId)?.visual.intent.orientation;
      const results = await Promise.allSettled(['video', 'image'].map(type => desktop.searchPexels({
        query, type: type as 'video' | 'image', page: 1, orientation
      })));
      if (token !== candidateSearchToken.current) return;
      const found = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
      const first = plan?.scenes.findIndex(scene => scene.id === sceneId) ?? -1;
      const last = throughSceneId ? plan?.scenes.findIndex(scene => scene.id === throughSceneId) ?? first : first;
      const duration = plan && first >= 0 && last >= first ? plan.scenes[last].endMs - plan.scenes[first].startMs : 0;
      const priority = (item: OnlineAsset) => item.type === 'video' ? (item.durationMs ?? 0) >= duration ? 0 : 2 : 1;
      setOnlineCandidates(found.sort((left, right) => priority(left) - priority(right)));
      const successful = results.find(result => result.status === 'fulfilled');
      setOnlineQuery(successful?.status === 'fulfilled' ? successful.value.query : query);
      if (results.every(result => result.status === 'rejected')) {
        setOnlineError(results[0].status === 'rejected' ? String(results[0].reason) : 'Pexels 搜索失败');
      }
    } catch (error) { if (token === candidateSearchToken.current) setOnlineError(error instanceof Error ? error.message : String(error)); }
    finally { if (token === candidateSearchToken.current) setOnlineLoading(false); }
  }

  async function loadCandidates(sceneId: string, query = '', throughSceneId = candidateThroughSceneId) {
    if (!projectId) return;
    const token = ++candidateSearchToken.current;
    setCandidateLoading(true); setCandidateError('');
    try {
      const result = await api()!.listSceneCandidates(projectId, sceneId, query, throughSceneId);
      if (token !== candidateSearchToken.current) return;
      setCandidateResult(result); setCandidatePreview(result.candidates[0]);
      void loadOnlineCandidates(result.query.split(/\s+/u).slice(0, 4).join(' '), sceneId, throughSceneId, token);
    } catch (error) { if (token === candidateSearchToken.current) setCandidateError(error instanceof Error ? error.message : String(error)); }
    finally { if (token === candidateSearchToken.current) setCandidateLoading(false); }
  }

  function openCandidates(sceneId: string) {
    candidateSearchToken.current++;
    setCandidateSceneId(sceneId); setCandidateResult(undefined); setCandidatePreview(undefined); setCandidateQuery('');
    setCandidateThroughSceneId(undefined); setOnlineCandidates([]); setOnlineError(''); setOnlineLoading(false);
    void loadCandidates(sceneId, '', undefined);
  }

  async function downloadAndApply(item: OnlineAsset) {
    if (!candidateSceneId) return;
    setDownloadingOnlineId(item.id); setCandidateError('');
    try {
      const asset = await api()!.downloadPexels(item.id);
      setAssets(await api()!.listAssets());
      await replaceScene(candidateSceneId, { type: 'asset', assetId: asset.id,
        sourceInMs: asset.type === 'video' ? 0 : undefined, throughSceneId: candidateThroughSceneId });
    } catch (error) { setCandidateError(error instanceof Error ? error.message : String(error)); }
    finally { setDownloadingOnlineId(undefined); }
  }

  async function replaceScene(sceneId: string, choice: SceneChoice) {
    if (!projectId) return;
    setReplacingScene(sceneId);
    setSceneNotice(undefined);
    try {
      const result = await api()?.replaceScene(projectId, sceneId, choice);
      if (result?.status === 'unavailable') setSceneNotice({ sceneId, message: result.message });
      else if (result) { setPlan(result.plan); setPreview(result.preview); setPreviewError(undefined); setExportProgress(undefined); setCandidateSceneId(undefined); }
    } catch (error) {
      setCandidateError(error instanceof Error ? error.message : String(error));
    } finally { setReplacingScene(undefined); }
  }

  async function configure() {
    const next = await api()?.configure({ enginePath, modelDir });
    if (next) { setStatus(next); if (next.state === 'idle') setSettingsOpen(false); }
  }

  async function configureSemantic(enginePath = semanticEnginePath, modelPath = semanticModelPath) {
    setSemanticNotice('');
    try {
      const result = await api()!.configureSemantic({ enginePath, modelPath });
      setSemanticEnginePath(result.enginePath); setSemanticModelPath(result.modelPath);
      setSemanticNotice(result.configured ? '本地语义检索已配置；首次检索会加载模型。' : '已关闭本地语义检索。');
    } catch (error) { setSemanticNotice(error instanceof Error ? error.message : String(error)); }
  }

  return <div className="app-shell">
    <header className="topbar drag-region">
      <div className="brand no-drag"><span className="brand-mark"><AudioLines size={19}/></span><strong>声织</strong><small>VOXWEAVE</small></div>
      <div className="top-actions no-drag">
        <button className="library-button" aria-label={`素材库，${assets.length} 个素材`} onClick={() => setLibraryOpen(true)}><Library size={16}/> <em>素材库</em> <span>{assets.length}</span></button>
        <button className={`engine-pill ${status.state}`} onClick={() => setSettingsOpen(true)}><i/>{modelsPending ? '正在准备模型' : status.state === 'idle' ? '本地引擎就绪' : '配置引擎'}</button>
        <button className="icon-button" aria-label="打开引擎设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18}/></button>
      </div>
    </header>

    {modelsPending && <section className="model-setup" aria-label="准备创作模型">
      <div role="status"><strong>首次使用需要下载创作模型</strong><p>{modelSetup.message}</p>
        <small>约 9 GB，下载完成后可离线使用。关闭应用后，下次启动会继续下载。</small>
        <p>已准备 {modelSetup.completedFiles} / {modelSetup.totalFiles} 个文件
          {modelSetup.state === 'downloading' && <> · {(modelSetup.downloadedBytes / 1024 ** 2).toFixed(1)} MiB
            {modelSetup.totalBytes ? ` / ${(modelSetup.totalBytes / 1024 ** 2).toFixed(1)} MiB` : ''}</>}</p>
        <progress aria-label="模型准备进度" value={modelSetup.completedFiles} max={modelSetup.totalFiles || 1}/>
      </div>
      {modelSetup.state === 'error' && <button className="secondary-button" onClick={() => void api()?.retryModelSetup()}><RefreshCw size={15}/> 重试下载</button>}
    </section>}

    <main className={`creator-layout ${plan ? 'has-storyboard' : ''}`}>
      <section className="create-pane" aria-labelledby="create-title">
        <div className="pane-heading"><span>AUTO COMPOSITION</span><h1 id="create-title">一段文案，自动成为一条片。</h1><p>旁白是真实时钟。字幕、画面和素材会跟着声音重新排好。</p></div>

        <label className="script-field">
          <span>视频文案</span>
          <textarea value={script} maxLength={8000} onChange={event => setScript(event.target.value)} placeholder="输入推广文案或观点内容…" disabled={working}/>
          <small><b>约 {estimatedSeconds || '—'} 秒</b>{script.length.toLocaleString()} / 8,000</small>
        </label>

        <label className="visual-brief-field"><span>画面方向 <small>可选，用于挑选素材</small></span><input value={visualBrief} maxLength={300} onChange={event => setVisualBrief(event.target.value)} placeholder="例如：城市夜景、年轻人、街头生活" disabled={working}/><small className="visual-brief-help">按主题查找视频和图片，不会读成旁白或自动添加特效。旁白语气由文案语义决定。</small></label>

        <div className="source-card">
          <div className="source-copy"><span className="source-icon"><Video size={18}/></span><div><b>原始视频</b><small>可选；不添加也能用素材与动效完成视频</small></div></div>
          {sourceVideoPath ? <div className="source-selected"><span title={sourceVideoPath}>{sourceVideoPath.split(/[\\/]/u).at(-1)}</span><button aria-label="移除原始视频" onClick={() => { setSourceVideoPath(undefined); setOriginalEnabled(false); }} disabled={working}><X size={15}/></button></div>
            : <button className="secondary-button" onClick={chooseSource} disabled={working}><Upload size={15}/> 添加视频</button>}
        </div>
        {sourceError && <p className="field-error" role="alert">原始视频入库失败：{sourceError}</p>}

        <button className="more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><Settings2 size={15}/> 更多设置{plan && preview ? ' · 音轨' : ''} <ChevronDown size={15}/></button>
        {moreOpen && <div className="settings-grid">
          <label><span>音色</span><select disabled={working} value={voiceId} onChange={event => setVoiceId(event.target.value)}>
            <optgroup label="内置音色">{voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.note}</option>)}</optgroup>
            {!!clonedVoices.length && <optgroup label="我的克隆音色">{clonedVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</optgroup>}
          </select><button type="button" className="text-action" disabled={modelsPending} onClick={() => setCloneOpen(true)}>克隆新音色</button></label>
          <label><span>画幅</span><select disabled={working} value={aspectRatio} onChange={event => setAspectRatio(event.target.value as typeof aspectRatio)}><option>9:16</option><option>16:9</option><option>1:1</option></select></label>
          <label><span>字幕风格</span><select disabled={working} value={captionStyle} onChange={event => setCaptionStyle(event.target.value as typeof captionStyle)}><option value="commerce-bold">电商强调</option><option value="opinion-clean">观点口播</option><option value="brand-minimal">品牌极简</option><option value="info-card">信息卡片</option></select></label>
          {plan && preview && <div className="bgm-controls">
            <b>音轨</b>
            <label>旁白音量 {Math.round(narrationVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={narrationVolume} disabled={working} onChange={event => setNarrationVolume(Number(event.target.value))}/></label>
            {plan.input.sourceVideoPath && <>
              <label><input type="checkbox" checked={originalEnabled} disabled={working || sourceAsset?.hasAudio === false} onChange={event => setOriginalEnabled(event.target.checked)}/> 保留原视频声音</label>
              {sourceAsset?.hasAudio === false ? <small>原视频没有音轨。</small> : <small>原声从视频开头播放，到原视频结束为止；更换画面时仍会继续。</small>}
              {originalEnabled && <><label>原声音量 {Math.round(originalVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={originalVolume} disabled={working} onChange={event => setOriginalVolume(Number(event.target.value))}/></label><label><input type="checkbox" checked={originalDucking} disabled={working} onChange={event => setOriginalDucking(event.target.checked)}/> 旁白说话时降低原声音量</label></>}
            </>}
            <label>背景音乐<select disabled={working} value={bgmAsset} onChange={event => setBgmAsset(event.target.value)}><option value="">不添加配乐</option>{assets.filter(asset => asset.type === 'audio').map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><button onClick={() => setLibraryOpen(true)}>导入 BGM</button></label>
            {bgmAsset && <><label>配乐音量 {Math.round(bgmVolume * 100)}%<input type="range" min="0" max="2" step="0.01" value={bgmVolume} disabled={working} onChange={event => setBgmVolume(Number(event.target.value))}/></label><label><input type="checkbox" checked={bgmDucking} disabled={working} onChange={event => setBgmDucking(event.target.checked)}/> 旁白说话时降低配乐音量</label></>}
          </div>}
        </div>}

        <div className="primary-row">
          {jobId && <button className="cancel-button" onClick={() => api()?.cancelComposition(jobId)}><Square size={14} fill="currentColor"/> 取消生成</button>}
          <button className={`generate-button ${needsGeneration ? 'needs-generation' : 'up-to-date'}`} disabled={working || modelsPending || !script.trim()} onClick={() => void generate()}><WandSparkles size={18}/>{modelsPending ? '正在准备模型…' : jobId || generatePending ? '正在自动成片…' : exportJob || exportPending ? '正在导出…' : bgmBusy ? '正在应用音轨…' : progress?.phase === 'error' || progress?.phase === 'cancelled' ? '重新生成' : '生成视频'}</button>
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
        {plan && preview && <div className="export-controls">
          <div className="export-actions"><button className="export-primary" disabled={working || !!replacingScene || needsGeneration} onClick={exportVideo}>{exportJob ? '正在导出…' : '导出 MP4'}</button>
            <button disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('narration-mp3')}>导出旁白 MP3</button>
            <button disabled={working || !!replacingScene || needsGeneration} onClick={() => void exportArtifact('mixed-mp3')}>导出混音 MP3</button>
            <button disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('srt')}>导出 SRT</button>
            <button disabled={working || !!replacingScene || compositionDirty} onClick={() => void exportArtifact('ass')}>导出 ASS</button>
            {exportJob && <button onClick={() => api()?.cancelExport(exportJob)}>取消导出</button>}
            {exportProgress?.outputPath && <button onClick={() => api()?.reveal(exportProgress.outputPath!)}>打开成品所在文件夹</button>}
          </div>
          {needsGeneration && <small>设置已修改，点击高亮的“生成视频”更新成片。</small>}
          {exportProgress && <div className="export-progress" role={exportProgress.phase === 'error' ? 'alert' : 'status'}><span>{exportProgress.message}</span>{exportJob && <progress max="1" value={exportProgress.progress}/>}</div>}
        </div>}
      </section>
      {plan && <aside className="storyboard" aria-label="分镜列表">
        <div className="storyboard-title"><span>分镜卡片</span><small>可让几句旁白共用一个画面</small></div>
        <div className="scene-list">{plan.scenes.map((scene, index) => <article key={scene.id} className="scene-card">
          <span className="scene-number">{String(index + 1).padStart(2, '0')}</span>
          <span className="scene-type">{scene.visual.type === 'kinetic-text' ? <Sparkles size={14}/> : scene.visual.type === 'image' ? <Image size={14}/> : <Video size={14}/>}</span>
          <div><b>{scene.script}</b><small>成片 {compositionSeconds(scene.startMs)}–{compositionSeconds(scene.endMs)} 秒 · {scene.visual.type === 'source' ? `原视频 ${((scene.visual.sourceInMs ?? 0) / 1000).toFixed(1)}–${((scene.visual.sourceOutMs ?? 0) / 1000).toFixed(1)} 秒` : scene.visual.type === 'kinetic-text' && originalVideoDurationMs && scene.startMs >= originalVideoDurationMs ? '原视频结束后的补画面' : scene.visual.type}{index > 0 && scene.visual.assetId && scene.visual.assetId === plan.scenes[index - 1].visual.assetId &&
            (scene.visual.type === 'image' || scene.visual.sourceInMs === plan.scenes[index - 1].visual.sourceOutMs) ? ' · 延续上一画面' : ''}</small></div>
          <button onClick={() => openCandidates(scene.id)} disabled={working || Boolean(replacingScene)}><RefreshCw size={14}/> 换画面</button>
          {sceneNotice?.sceneId === scene.id && <p className="scene-notice" role="status">{sceneNotice.message}</p>}
        </article>)}</div>
      </aside>}
    </main>

    {candidateSceneId && <Modal title="选择分镜画面" subtitle={plan?.scenes.find(scene => scene.id === candidateSceneId)?.script ?? ''} close={() => {
      if (replacingScene || downloadingOnlineId) return;
      candidateSearchToken.current++; setCandidateSceneId(undefined);
    }} wide>
      {plan && candidateStartIndex >= 0 && <label className="candidate-scope">画面覆盖范围
        <select value={candidateThroughSceneId ?? ''} disabled={!!downloadingOnlineId || !!replacingScene} onChange={event => {
          const through = event.target.value || undefined; setCandidateThroughSceneId(through);
          void loadCandidates(candidateSceneId, candidateQuery, through);
        }}>
          {plan.scenes.slice(candidateStartIndex, candidateStartIndex + 10).map((scene, offset) =>
            <option key={scene.id} value={offset ? scene.id : ''}>{offset ? `到第 ${candidateStartIndex + offset + 1} 句` : '仅这一句'} · 成片 {compositionSeconds(scene.endMs - plan.scenes[candidateStartIndex].startMs)} 秒</option>)}
        </select><small>字幕仍逐句显示；所选画面连续覆盖这段旁白，并使用成片的 {compositionRate}× 倍速。</small>
      </label>}
      {plan?.input.sourceVideoPath && candidateStartIndex >= 0 && <p className="candidate-message">
        {plan.scenes.slice(candidateStartIndex, candidateEndIndex + 1).some(scene => scene.visual.type === 'source')
          ? '当前范围含原视频画面；替换只作用于所选时间段，其他原视频时间段保持原样。'
          : originalVideoDurationMs && plan.scenes[candidateStartIndex].startMs >= originalVideoDurationMs
            ? '这段旁白已超出原视频时长，使用额外素材或动态文字补画面。'
            : '替换只作用于所选时间段，其他原视频时间段保持原样。'}
      </p>}
      <form className="candidate-search" onSubmit={event => { event.preventDefault(); void loadCandidates(candidateSceneId, candidateQuery); }}>
        <label>画面关键词<input value={candidateQuery} maxLength={150} disabled={!!downloadingOnlineId || !!replacingScene} onChange={event => setCandidateQuery(event.target.value)} placeholder="留空使用整篇文案的画面方向"/></label>
        <button disabled={candidateLoading || !!downloadingOnlineId || !!replacingScene} type="submit">搜索</button>
      </form>
      {candidateLoading && <p className="candidate-message" role="status">正在查找本地画面…</p>}
      {candidateError && <p className="field-error" role="alert">{candidateError}</p>}
      {candidateResult && <><p className="candidate-message">{candidateResult.query ? `检索方向：${candidateResult.query}（${candidateResult.querySource === 'manual' ? '手动指定' : candidateResult.querySource === 'story' ? '整篇文案' : '当前分镜'}）` : '当前没有明确画面主题'} · 覆盖成片 {compositionSeconds(candidateDurationMs)} 秒{candidateResult.notice ? ` · ${candidateResult.notice}` : ''}</p>
        <h3 className="candidate-section-title">本地素材 <small>需要原素材 {(candidateDurationMs / 1000).toFixed(1)} 秒；视频只取所需片段，过短的不列入候选。</small></h3>
        <div className="candidate-layout">
          <div className="candidate-grid">{candidateResult.candidates.map((candidate, index) => <button type="button" key={`${candidate.asset.id}-${candidate.choice.type === 'asset' ? candidate.choice.sourceInMs ?? 0 : index}`} className={candidatePreview === candidate ? 'active' : ''} onClick={() => setCandidatePreview(candidate)}>
            {candidate.asset.thumbnailPath ? <img src={`voxweave-library://${candidate.asset.id}/thumbnail`} alt=""/> : <span className="candidate-placeholder">{candidate.asset.type === 'video' ? '视频' : '图片'}</span>}
            <span><b>{candidate.asset.name}</b><small>{candidate.match === 'related' ? '关键词相关' : candidate.match === 'semantic' ? '素材文字语义排序' : candidate.match === 'alternate' ? '同一视频其他片段' : '填充画面'}{candidate.choice.type === 'asset' && candidate.asset.type === 'video' ? ` · ${((candidate.choice.sourceInMs ?? 0) / 1000).toFixed(1)}s 起` : ''}</small></span>
          </button>)}{!candidateResult.candidates.length && <p>素材库中没有满足时长和授权条件的其他画面。</p>}</div>
          <div className="candidate-detail">{candidatePreview ? <>
            {candidatePreview.asset.type === 'video' ? <video key={`${candidatePreview.asset.id}-${candidatePreview.choice.type === 'asset' ? candidatePreview.choice.sourceInMs : 0}`} src={`voxweave-library://${candidatePreview.asset.id}/media`} controls preload="metadata" onLoadedMetadata={event => { event.currentTarget.playbackRate = compositionRate; if (candidatePreview.choice.type === 'asset') event.currentTarget.currentTime = (candidatePreview.choice.sourceInMs ?? 0) / 1000; }} onTimeUpdate={event => { if (candidatePreview.sourceOutMs !== undefined && event.currentTarget.currentTime >= candidatePreview.sourceOutMs / 1000) event.currentTarget.pause(); }}/>
              : <img src={`voxweave-library://${candidatePreview.asset.id}/media`} alt={candidatePreview.asset.name}/>}
            <b>{candidatePreview.asset.name}</b><small>{candidatePreview.reasons.join(' · ')}</small>
            <button className="modal-primary" disabled={!!replacingScene} onClick={() => replaceScene(candidateSceneId, candidatePreview.choice)}>{replacingScene ? '正在更新预览…' : '应用这个画面'}</button>
          </> : <p>选择左侧素材预览。也可以使用动态文字。</p>}
            <button disabled={!!replacingScene || plan?.scenes.find(scene => scene.id === candidateSceneId)?.visual.type === 'kinetic-text' && !candidateThroughSceneId} onClick={() => replaceScene(candidateSceneId, { type: 'kinetic-text', throughSceneId: candidateThroughSceneId })}>使用动态文字</button>
          </div>
        </div>
        <h3 className="candidate-section-title">Pexels 在线素材 <small>同时搜索视频和图片；只在选择后下载。<button onClick={() => void api()?.openSource('https://www.pexels.com/')}>素材由 Pexels 提供</button></small></h3>
        {onlineLoading && <p className="candidate-message" role="status">正在搜索 Pexels 视频和图片…</p>}
        {onlineQuery && <p className="candidate-message">Pexels 搜索词：{onlineQuery}</p>}
        {onlineError && <p className="candidate-message" role="status">{onlineError} <button onClick={() => { setCandidateSceneId(undefined); setLibraryOpen(true); }}>打开素材库设置</button></p>}
        {!!onlineCandidates.length && <div className="candidate-online-grid">{onlineCandidates.map(item => {
          const tooShort = item.type === 'video' && (item.durationMs ?? 0) < candidateDurationMs;
          return <article key={item.id} className="candidate-online-card">
            <img src={item.thumbnailUrl} alt="" loading="lazy"/>
            <div><b>{item.name}</b><small>{item.type === 'video' ? `视频 · ${((item.durationMs ?? 0) / 1000).toFixed(1)} 秒` : '图片'} · {item.author}</small>
              <small>{tooShort ? '原素材时长不足，不能直接使用' : item.type === 'video' ? `取原素材前 ${(candidateDurationMs / 1000).toFixed(1)} 秒，成片 ${compositionSeconds(candidateDurationMs)} 秒` : `成片保持 ${compositionSeconds(candidateDurationMs)} 秒`}</small>
              <button disabled={tooShort || !!downloadingOnlineId || !!replacingScene} onClick={() => void downloadAndApply(item)}>{downloadingOnlineId === item.id ? '正在下载并应用…' : '下载并应用'}</button>
              <button className="candidate-source-link" onClick={() => void api()?.openSource(item.sourceUrl)}>查看作者与来源</button>
            </div>
          </article>;
        })}</div>}
      </>}
    </Modal>}

    {cloneOpen && <Modal title="克隆音色" subtitle="选择有权使用的参考音频，使用本机 Base 模型生成可复用音色" close={() => !cloneBusy && setCloneOpen(false)}>
      <div className="settings-form">
        <label className="clone-field">音色名称<input value={cloneName} maxLength={60} onChange={event => setCloneName(event.target.value)} placeholder="例如：我的旁白"/></label>
        <label className="clone-field">参考音频<div><input readOnly value={cloneReference} placeholder="建议 5–20 秒清晰单人语音"/><button onClick={async () => { const selected = await api()?.chooseFile('audio'); if (selected) setCloneReference(selected); }}>选择音频</button></div></label>
        {cloneError && <p className="field-error" role="alert">{cloneError}</p>}
        <button className="modal-primary" disabled={cloneBusy || !cloneName.trim() || !cloneReference} onClick={createClone}>{cloneBusy ? '正在克隆…' : '创建并使用音色'}</button>
      </div>
    </Modal>}

    {libraryOpen && <Modal title="素材库" subtitle="整理画面、图片与声音，为下一条视频积累素材" close={() => setLibraryOpen(false)} wide>
      <LibraryPanel changed={async () => setAssets(await api()!.listAssets())}/>
    </Modal>}

    {settingsOpen && <Modal title="本地引擎设置" subtitle="旁白和可选语义检索都在本机运行" close={() => setSettingsOpen(false)}>
      <div className="settings-form"><PathField label="引擎路径" value={enginePath} placeholder="qwen_tts.exe 或 WSL 可执行文件" choose={async () => { const selected = await api()?.chooseFile('engine'); if (selected) setEnginePath(selected); }}/><PathField label="旁白模型目录" value={modelDir} placeholder="qwen3-tts-1.7b-customvoice" choose={async () => { const selected = await api()?.chooseFile('model'); if (selected) setModelDir(selected); }}/>
        <div className={`engine-summary ${status.state}`}><i/><span><b>{status.message}</b><small>文本与媒体只在本机处理。</small></span></div><button className="modal-primary" onClick={configure}>保存并检测旁白引擎</button>
        <div className="semantic-settings"><b>本地语义检索（可选）</b><small>使用 llama.cpp 的 CPU 运行器和 Qwen3 Embedding GGUF；只比较素材已有文字信息，不识别视频画面。</small></div>
        <PathField label="llama-server 路径" value={semanticEnginePath} placeholder="选择 llama-server.exe" choose={async () => { const selected = await api()?.chooseFile('semantic-engine'); if (selected) setSemanticEnginePath(selected); }}/>
        <PathField label="Embedding GGUF 路径" value={semanticModelPath} placeholder="选择 Qwen3-Embedding-0.6B.gguf" choose={async () => { const selected = await api()?.chooseFile('semantic-model'); if (selected) setSemanticModelPath(selected); }}/>
        {semanticNotice && <p className="candidate-message" role="status">{semanticNotice}</p>}
        <div className="semantic-actions"><button className="modal-primary" disabled={!semanticEnginePath || !semanticModelPath} onClick={() => void configureSemantic()}>启用语义检索</button><button onClick={() => void configureSemantic('', '')}>关闭</button></div>
      </div>
    </Modal>}
  </div>;
}

function PathField({ label, value, placeholder, choose }: { label: string; value: string; placeholder: string; choose: () => void }) {
  return <label className="path-field"><span>{label}</span><div><input readOnly value={value} placeholder={placeholder}/><button onClick={choose}><FolderOpen size={15}/> 浏览</button></div></label>;
}

function Modal({ title, subtitle, close, children, wide }: { title: string; subtitle: string; close: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && close()}><section ref={ref} className={`modal ${wide ? 'library-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="关闭" onClick={close}><X size={18}/></button></header>{children}</section></div>;
}
