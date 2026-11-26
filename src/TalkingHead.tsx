import '@hyperframes/player';
import { useEffect, useRef, useState } from 'react';
import type { HyperframesPlayer } from '@hyperframes/player';
import { Film, FolderOpen, Play, Plus, RefreshCw, Scissors, Square, Upload, X } from 'lucide-react';
import { TalkVoiceEnhancement } from './TalkVoiceEnhancement';
import { sourceToTalkTime, talkDuration, type TalkProject, type TalkResult, type TalkProgress,
  type TalkUpdate, type TalkExportProgress, type TalkOverlay, type TalkCaptionSettings } from '../shared/talking-head';
import type { MediaAsset } from '../shared/library';

const desktop = () => window.voxweave;
const api = () => desktop()?.talkingHead;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const seconds = (time: number) => `${(time / 1000).toFixed(2)} 秒`;
const strengthNames = { light: '轻度', natural: '自然', tight: '紧凑' };
const revealNames = { sentence: '整句出现', character: '逐字出现', phrase: '逐词组出现' };

export function TalkingHead({ active, assets, dialogOpen, openLibrary }: {
  active: boolean; assets: MediaAsset[]; dialogOpen: boolean; openLibrary: () => void;
}) {
  const [result, setResult] = useState<TalkResult>();
  const project = result?.project;
  const [status, setStatus] = useState({ ready: false, message: '正在检测口播资源…' });
  const [sourcePath, setSourcePath] = useState('');
  const [strength, setStrength] = useState<TalkProject['strength']>('natural');
  const [job, setJob] = useState<string>();
  const [progress, setProgress] = useState<TalkProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportJob, setExportJob] = useState<string>();
  const [exportProgress, setExportProgress] = useState<TalkExportProgress>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedCue, setSelectedCue] = useState('');
  const [tab, setTab] = useState<'captions' | 'cuts' | 'visuals'>('captions');
  const [manualStart, setManualStart] = useState('0');
  const [manualEnd, setManualEnd] = useState('');
  const [sourcePreview, setSourcePreview] = useState<{ startMs: number; endMs: number; label: string }>();
  const [overlayType, setOverlayType] = useState<TalkOverlay['type']>('callout');
  const [overlayText, setOverlayText] = useState('');
  const [overlayAsset, setOverlayAsset] = useState('');
  const [overlayLayout, setOverlayLayout] = useState<TalkOverlay['layout']>('pip');
  const [overlayPosition, setOverlayPosition] = useState<TalkOverlay['position']>('top-right');
  const [cueQuery, setCueQuery] = useState('');
  const playerRef = useRef<HyperframesPlayer>(null), sourceRef = useRef<HTMLVideoElement>(null);
  const jobRef = useRef<string | undefined>(undefined), exportRef = useRef<string | undefined>(undefined);
  const generationReceived = useRef(false);
  const finishedJobs = useRef(new Set<string>()), finishedExports = useRef(new Set<string>());
  const resumeRequest = useRef<Promise<TalkResult | null> | undefined>(undefined);
  const pending = busy || !!job || !!exportJob;

  function accept(next: TalkResult, clearDrafts = true) {
    setResult(next); setStrength(next.project.strength);
    if (clearDrafts) setDrafts({});
    setSelectedCue(previous => next.project.cues.some(cue => cue.id === previous) ? previous : next.project.cues[0]?.id ?? '');
  }
  async function refreshStatus() {
    try { setStatus(await api()?.status() ?? { ready: false, message: '请在帧舟桌面应用中使用口播精剪。' }); }
    catch (error) { setStatus({ ready: false, message: messageOf(error) }); }
  }
  useEffect(() => {
    const talk = api();
    if (!talk) { void refreshStatus(); return; }
    let mounted = true;
    void refreshStatus();
    const unsubscribe = talk.onProgress(event => {
      generationReceived.current = true;
      if (jobRef.current && jobRef.current !== event.jobId) return;
      setProgress(event);
      if (event.result) { accept(event.result); setSourcePath(''); setNotice('长停顿已整理，口头语建议请试听后决定。'); }
      if (['complete', 'cancelled', 'error'].includes(event.phase)) {
        finishedJobs.current.add(event.jobId);
        jobRef.current = undefined; setJob(undefined); setBusy(false);
        if (event.phase === 'error') setError(event.message);
      }
    });
    const unsubscribeExport = talk.onExportProgress(event => {
      if (exportRef.current && exportRef.current !== event.jobId) return;
      setExportProgress(event);
      if (['complete', 'cancelled', 'error'].includes(event.phase)) { finishedExports.current.add(event.jobId); exportRef.current = undefined; setExportJob(undefined); setBusy(false); }
    });
    setBusy(true);
    resumeRequest.current ??= talk.resume();
    void resumeRequest.current.then(last => { if (mounted && last && !generationReceived.current) accept(last); })
      .catch(error => { if (mounted) setError(`口播工程恢复失败：${messageOf(error)}`); })
      .finally(() => { if (mounted) setBusy(false); });
    return () => { mounted = false; unsubscribe(); unsubscribeExport(); };
  }, []);
  useEffect(() => { if (active) void refreshStatus(); }, [active]);
  useEffect(() => desktop()?.onModelSetupProgress?.(value => {
    if (value.state === 'ready' || value.state === 'error') void refreshStatus();
  }), []);
  useEffect(() => {
    if (!active) { playerRef.current?.pause(); sourceRef.current?.pause(); }
  }, [active]);
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const failed = (event: Event) => setError((event as CustomEvent<{ message?: string }>).detail?.message ?? '口播预览加载失败');
    player.addEventListener('error', failed);
    return () => player.removeEventListener('error', failed);
  }, [result?.preview.entryUrl]);
  useEffect(() => {
    const video = sourceRef.current;
    if (!video || !sourcePreview) return;
    const seek = () => { video.currentTime = sourcePreview.startMs / 1000; };
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [sourcePreview, result?.preview.sourceUrl]);
  useEffect(() => {
    if (!active || !sourcePreview) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('.talk-dialog');
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        sourceRef.current?.pause(); setSourcePreview(undefined);
      }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),video[controls],summary') ?? [])]
        .filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [!!sourcePreview, active]);

  async function chooseSource() {
    setError('');
    try { const file = await desktop()?.chooseFile('video'); if (file) setSourcePath(file); }
    catch (error) { setError(messageOf(error)); }
  }
  async function create() {
    if (!api() || !sourcePath) return;
    setBusy(true); setError(''); setNotice(''); setExportProgress(undefined); generationReceived.current = false;
    try {
      const next = await api()!.create({ sourcePath, strength });
      // The IPC result normally precedes progress; respect an already completed fast job too.
      if (!finishedJobs.current.has(next.jobId)) {
        jobRef.current = next.jobId; setJob(next.jobId);
      }
    } catch (error) { setError(messageOf(error)); setBusy(false); }
  }
  async function update(change: Omit<TalkUpdate, 'revision'>, saveDrafts = true) {
    if (!project || !api() || pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const edits = saveDrafts ? Object.entries(drafts).map(([cueId, text]) => ({ cueId, text })) : [];
      const next = await api()!.update(project.id, { revision: project.revision, ...(edits.length ? { edits } : {}), ...change });
      accept(next, saveDrafts); setNotice('改动已保存，预览已更新。');
    } catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  async function exportFile(kind: 'mp4' | 'srt' | 'ass') {
    if (!project || !api() || pending) return;
    setBusy(true); setError(''); setExportProgress(undefined);
    try { const next = await api()!.export(project.id, kind); if (next && !finishedExports.current.has(next.jobId)) { exportRef.current = next.jobId; setExportJob(next.jobId); } }
    catch (error) { setError(messageOf(error)); }
    finally { setBusy(false); }
  }
  function inspect(startMs: number, endMs: number, label: string) {
    playerRef.current?.pause();
    setSourcePreview({ startMs: Math.max(0, startMs - 600), endMs: Math.min(project?.source.durationMs ?? endMs + 600, endMs + 600), label });
    setManualStart((startMs / 1000).toFixed(3)); setManualEnd((endMs / 1000).toFixed(3));
  }
  async function addOverlay() {
    if (!project || !selectedCue) return;
    const existing = project.overlays.find(overlay => overlay.cueId === selectedCue);
    const overlay: TalkOverlay = { id: existing?.id ?? crypto.randomUUID(), cueId: selectedCue,
      type: overlayType, text: overlayText, assetId: ['image', 'video'].includes(overlayType) ? overlayAsset || undefined : undefined,
      layout: overlayLayout, position: overlayPosition, sourceInMs: 0, enabled: true };
    await update({ overlays: [...project.overlays.filter(overlay => overlay.cueId !== selectedCue), overlay] });
  }
  function chooseCue(id: string) {
    setSelectedCue(id);
    const overlay = project?.overlays.find(overlay => overlay.cueId === id);
    const cue = project?.cues.find(cue => cue.id === id);
    setOverlayType(overlay?.type ?? 'callout'); setOverlayText(overlay?.text ?? cue?.text.replace(/\|/gu, '') ?? '');
    setOverlayAsset(overlay?.assetId ?? ''); setOverlayLayout(overlay?.layout ?? 'pip'); setOverlayPosition(overlay?.position ?? 'top-right');
  }
  const dirty = Object.keys(drafts).length > 0;
  const removed = project ? project.source.durationMs - talkDuration(project) : 0;
  const filteredCues = project?.cues.filter(cue => `${cue.originalText}${drafts[cue.id] ?? cue.text}`.includes(cueQuery)).slice(0, 200) ?? [];

  return <div className="talk-app app-shell">
    <main className="talk-layout">
      <section className="talk-controls" aria-label="口播导入与设置">
        <div className="pane-heading"><span>TALKING HEAD</span><h1>保留你的表达，<br/>剪出自然节奏。</h1><p>导入真人口播，整理停顿、校正字幕，再为重点补上画面。</p></div>
        <div className="talk-import">
          <Scissors size={27}/><b>{sourcePath ? sourcePath.split(/[\\/]/u).at(-1) : '导入带原声的口播视频'}</b>
          <small>原片会保存到独立工程中，所有剪辑都可以恢复。</small>
          <button className="secondary-button" disabled={pending} onClick={() => void chooseSource()}><Upload size={15}/> {sourcePath ? '更换视频' : '选择视频'}</button>
        </div>
        <label className="talk-field">剪辑强度<select aria-label="口播剪辑强度" disabled={pending} value={strength} onChange={event => setStrength(event.target.value as typeof strength)}>
          {Object.entries(strengthNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select><small>调整长停顿保留长度；口头语建议需试听确认。</small></label>
        <button className="generate-button" disabled={pending || !sourcePath || !status.ready} onClick={() => void create()}><Scissors size={17}/> {job ? '正在整理口播…' : '开始口播精剪'}</button>
        {project && strength !== project.strength && !sourcePath && <button className="secondary-button" disabled={pending} onClick={() => void update({ strength })}>将强度应用到当前口播</button>}
        <p className={`talk-status ${status.ready ? 'ready' : ''}`} role="status">{status.message}</p>
        {!status.ready && <div className="talk-actions">
          <button disabled={pending} onClick={() => void refreshStatus()}><RefreshCw size={14}/> 检测资源</button>
          <button disabled={pending} onClick={() => void desktop()?.retryModelSetup()}>重试资源下载</button>
        </div>}
        {progress && <div className="talk-progress" role="status"><span>{progress.message}</span>{!['complete', 'error', 'cancelled'].includes(progress.phase) && <progress value={progress.progress} max="1"/>}</div>}
        {job && <button className="secondary-button" onClick={() => void api()?.cancel(job)}><Square size={13}/> 取消处理</button>}
        {project && <>
          <div className="talk-divider"/>
          <label className="talk-field">字幕出现方式<select aria-label="口播字幕出现方式" disabled={pending} value={project.captions.reveal}
            onChange={event => void update({ captions: { ...project.captions, reveal: event.target.value as TalkCaptionSettings['reveal'] } })}>
            {Object.entries(revealNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          <label className="talk-field">字幕强调<select aria-label="口播字幕强调" disabled={pending} value={project.captions.highlight}
            onChange={event => void update({ captions: { ...project.captions, highlight: event.target.value as TalkCaptionSettings['highlight'] } })}>
            <option value="none">无</option><option value="color">当前字词变色</option><option value="box">底框</option><option value="scale">轻微缩放</option>
          </select></label>
          <label className="talk-field">字幕位置<select disabled={pending} value={project.captions.position}
            onChange={event => void update({ captions: { ...project.captions, position: event.target.value as 'top' | 'bottom' } })}><option value="bottom">下方</option><option value="top">上方</option></select></label>
          <label className="talk-check"><input type="checkbox" checked={project.captions.enabled} disabled={pending} onChange={event => void update({ captions: { ...project.captions, enabled: event.target.checked } })}/> 显示视频字幕</label>
          <details className="talk-audio"><summary>原声与配乐</summary>
            <TalkVoiceEnhancement key={project.id} project={project} disabled={pending} playerRef={playerRef}
              canAudition={active && !sourcePreview && !dialogOpen}
              apply={voiceEnhancement => void update({ audio: { ...project.audio, voiceEnhancement } }, false)}/>
            <label className="talk-field">原声音量 {Math.round(project.audio.voiceVolume * 100)}%<input aria-label="口播原声音量" type="range" min="0" max="2" step="0.05" disabled={pending}
              defaultValue={project.audio.voiceVolume} key={`${project.id}-${project.revision}-volume`} onPointerUp={event => { const value = Number(event.currentTarget.value); if (value !== project.audio.voiceVolume) void update({ audio: { ...project.audio, voiceVolume: value } }); }}
              onKeyUp={event => { if (event.key.startsWith('Arrow')) void update({ audio: { ...project.audio, voiceVolume: Number(event.currentTarget.value) } }); }}/></label>
            <label className="talk-field">背景音乐<select aria-label="口播背景音乐" value={project.audio.bgmAssetId ?? ''} disabled={pending} onChange={event => void update({ audio: { ...project.audio, bgmAssetId: event.target.value || undefined } })}>
              <option value="">不添加配乐</option>{project.audio.bgmAssetId && !assets.some(asset => asset.id === project.audio.bgmAssetId && asset.type === 'audio' && asset.license.status !== 'unknown') &&
                <option value={project.audio.bgmAssetId} disabled>原配乐不可用</option>}
              {assets.filter(asset => asset.type === 'audio' && asset.license.status !== 'unknown').map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select></label>
            {project.audio.bgmAssetId && <><label className="talk-field">配乐音量<select disabled={pending} value={project.audio.bgmVolume} onChange={event => void update({ audio: { ...project.audio, bgmVolume: Number(event.target.value) } })}>
              {[.05, .1, .12, .15, .2, .3, .5].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}</select></label>
              <label className="talk-check"><input type="checkbox" checked={project.audio.ducking} disabled={pending} onChange={event => void update({ audio: { ...project.audio, ducking: event.target.checked } })}/> 说话时自动降低配乐</label></>}
          </details>
        </>}
      </section>

      <section className="talk-preview" aria-label="口播成片预览">
        <div className="talk-section-title"><h2>成片预览</h2>{project && <small>已缩短 {seconds(removed)}</small>}</div>
        <div className={`talk-stage ${result ? 'has-video' : ''}`} style={result ? {
          aspectRatio: `${result.preview.width}/${result.preview.height}`,
          width: `min(100%, ${58 * result.preview.width / result.preview.height}vh)`
        } : undefined}>
          {result ? <hyperframes-player key={result.preview.entryUrl} ref={playerRef} src={result.preview.entryUrl} width={result.preview.width} height={result.preview.height} controls/>
            : <div className="talk-empty"><Film size={40}/><h3>从你录好的口播开始</h3><p>自然停顿、原声和你的表达，<br/>都由你决定如何保留。</p></div>}
        </div>
        {project && result && <>
          <p className="talk-metadata">{project.source.name} · {seconds(result.preview.durationMs)} · {project.source.width} × {project.source.height}</p>
          <div className="talk-actions"><button className="talk-primary" disabled={pending || dirty} onClick={() => void exportFile('mp4')}><Film size={15}/> 导出 MP4</button>
            <button disabled={pending || dirty} onClick={() => void exportFile('srt')}>SRT</button><button disabled={pending || dirty} onClick={() => void exportFile('ass')}>动态 ASS</button></div>
          {dirty && <p className="talk-hint">保存字幕后即可导出。</p>}
        </>}
        {exportProgress && <div className="talk-progress" role="status"><span>{exportProgress.message}</span>
          {!['complete', 'error', 'cancelled'].includes(exportProgress.phase) && <progress max="1" value={exportProgress.progress}/>}
          {exportProgress.outputPath && <button onClick={() => void desktop()?.reveal(exportProgress.outputPath!)}><FolderOpen size={14}/> 查看导出文件</button>}</div>}
        {exportJob && <button className="secondary-button" onClick={() => void api()?.cancelExport(exportJob)}>取消导出</button>}
        {busy && <p className="talk-hint" role="status">正在准备预览或保存改动…</p>}
        {notice && <p className="talk-notice" role="status">{notice}</p>}
        {error && <p className="talk-error" role="alert">{error}</p>}
        {result?.preview.warnings?.map(warning => <p className="talk-hint" role="status" key={warning}>{warning}</p>)}
        {project && <details className="talk-analysis-note"><summary>识别与剪辑说明</summary>{project.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
      </section>

      <section className="talk-editor" aria-label="口播精修">
        <div className="talk-tabs" role="group" aria-label="精修内容"><button aria-pressed={tab === 'captions'} onClick={() => setTab('captions')}>字幕校正</button><button aria-pressed={tab === 'cuts'} onClick={() => setTab('cuts')}>剪辑记录</button><button aria-pressed={tab === 'visuals'} onClick={() => { setTab('visuals'); chooseCue(selectedCue); }}>画面增强</button></div>
        {!project ? <p className="talk-hint">完成识别后，在这里校正字幕、试听剪点和添加画面。</p> : <>
          {tab === 'captions' && <>
            <p className="talk-hint">修改或清空字幕只改变文字。用 | 指定词组边界；剪除音视频请到「剪辑记录」。</p>
            <div className="talk-editor-toolbar"><input aria-label="搜索口播字幕" placeholder="搜索字幕或原始识别文字" value={cueQuery} onChange={event => setCueQuery(event.target.value)}/>
              <button className="talk-primary" disabled={!dirty || pending} onClick={() => void update({})}>保存字幕</button></div>
            <div className="talk-cue-list">{filteredCues.map(cue => {
              const fullyRemoved = project.cuts.some(cut => cut.applied && cut.startMs <= cue.startMs && cut.endMs >= cue.endMs);
              return <article className={`talk-cue ${fullyRemoved ? 'removed' : ''}`} key={cue.id}>
                <div className="talk-cue-heading"><button disabled={pending} onClick={() => inspect(cue.startMs, cue.endMs, '原句试听')}><Play size={12}/> 原片 {(cue.startMs / 1000).toFixed(2)}s</button>
                  <span>{fullyRemoved ? '已剪除，可恢复' : `成片 ${(sourceToTalkTime(project, cue.startMs) / 1000).toFixed(2)}s`}</span></div>
                <label><span className="talk-sr-only">字幕 {cue.id}</span><textarea aria-label={`字幕 ${cue.id}`} value={drafts[cue.id] ?? cue.text} disabled={pending} maxLength={2000} rows={2}
                  onChange={event => { const text = event.target.value; setDrafts(previous => { const next = { ...previous }; if (text === cue.text) delete next[cue.id]; else next[cue.id] = text; return next; }); }}/></label>
                <details><summary>原始识别</summary><p>{cue.originalText}</p><button disabled={pending} onClick={() => setDrafts(previous => ({ ...previous, [cue.id]: cue.originalText }))}>恢复原始字幕文字</button></details>
                <button className="talk-text-button" disabled={pending} onClick={() => { chooseCue(cue.id); setTab('visuals'); }}>为这句话添加画面</button>
              </article>;
            })}</div>
            {project.cues.filter(cue => `${cue.originalText}${drafts[cue.id] ?? cue.text}`.includes(cueQuery)).length > 200 && <p className="talk-hint">当前显示前 200 条，请搜索定位其余字幕。</p>}
          </>}
          {tab === 'cuts' && <>
            <p className="talk-hint">时间均为原片位置。长停顿已自动缩短；口头语保持原样，试听后再决定。</p>
            <div className="talk-manual"><b>手动剪除音视频</b><div><label>起点（秒）<input aria-label="手动剪辑起点" type="number" min="0" step="0.001" value={manualStart} disabled={pending} onChange={event => setManualStart(event.target.value)}/></label>
              <label>终点（秒）<input aria-label="手动剪辑终点" type="number" min="0" step="0.001" value={manualEnd} disabled={pending} onChange={event => setManualEnd(event.target.value)}/></label></div>
              <div className="talk-actions"><button disabled={pending || !manualEnd || Number(manualEnd) <= Number(manualStart)} onClick={() => inspect(Number(manualStart) * 1000, Number(manualEnd) * 1000, '手动剪辑试听')}><Play size={13}/> 试听附近</button>
                <button disabled={pending || !manualEnd || Number(manualEnd) <= Number(manualStart)} onClick={() => void update({ manualCut: { startMs: Math.round(Number(manualStart) * 1000), endMs: Math.round(Number(manualEnd) * 1000) } })}><Scissors size={13}/> 剪除这段音视频</button></div>
            </div>
            <div className="talk-cut-list">{project.cuts.map(cut => <article className={`talk-cut ${cut.applied ? 'applied' : ''}`} key={cut.id}>
              <div><b>{cut.kind === 'pause' ? '长停顿' : cut.kind === 'filler' ? '口头语建议' : cut.kind === 'restart' ? '重复起句建议' : '手动剪辑'}</b><span>{cut.applied ? '已剪除' : cut.decided ? '已保留' : '待试听'}</span></div>
              <small>{(cut.startMs / 1000).toFixed(2)}–{(cut.endMs / 1000).toFixed(2)} 秒 · {seconds(cut.endMs - cut.startMs)}</small><p>{cut.reason}</p>
              <div className="talk-actions"><button disabled={pending} onClick={() => inspect(cut.startMs, cut.endMs, cut.reason)}><Play size={12}/> 试听</button>
                <button disabled={pending} onClick={() => void update({ cutDecisions: [{ cutId: cut.id, applied: !cut.applied }] })}>{cut.applied ? '恢复这段' : '剪除这段'}</button>
                {!cut.applied && !cut.decided && <button disabled={pending} onClick={() => void update({ cutDecisions: [{ cutId: cut.id, applied: false }] })}>保留这段</button>}</div>
            </article>)}</div>
            {!project.cuts.length && <p className="talk-hint">未发现可自动处理的长停顿或口头语建议。可以在上方手动指定区间。</p>}
          </>}
          {tab === 'visuals' && <>
            <p className="talk-hint">画面跟随所选原句；覆盖画面时原声继续。素材不足时保留人物画面。</p>
            <label className="talk-field">关联口播<select aria-label="画面关联口播" value={selectedCue} disabled={pending} onChange={event => chooseCue(event.target.value)}>{project.cues.map(cue => <option value={cue.id} key={cue.id}>{(cue.startMs / 1000).toFixed(1)}s · {cue.text.replace(/\|/gu, '').slice(0, 36) || cue.originalText}</option>)}</select></label>
            <label className="talk-field">增强类型<select aria-label="口播增强类型" value={overlayType} disabled={pending} onChange={event => setOverlayType(event.target.value as typeof overlayType)}><option value="callout">重点卡片</option><option value="whiteboard">手绘线框图解</option><option value="image">图片 / 贴图</option><option value="video">B-roll 视频</option></select></label>
            {['callout', 'whiteboard'].includes(overlayType) ? <label className="talk-field">图解文字<textarea aria-label="图解文字" maxLength={300} value={overlayText} disabled={pending} onChange={event => setOverlayText(event.target.value)} placeholder="输入需要强调的要点，可换行…"/></label>
              : <label className="talk-field">素材<select aria-label="口播增强素材" disabled={pending} value={overlayAsset} onChange={event => setOverlayAsset(event.target.value)}><option value="">选择素材</option>{assets.filter(asset => asset.type === overlayType).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><button className="talk-text-button" disabled={pending} onClick={openLibrary}>打开素材库导入 / 搜索素材</button></label>}
            <label className="talk-field">显示方式<select value={overlayLayout} disabled={pending} onChange={event => setOverlayLayout(event.target.value as typeof overlayLayout)}><option value="pip">画中画</option><option value="cover">全屏覆盖</option></select></label>
            {overlayLayout === 'pip' && <label className="talk-field">位置<select value={overlayPosition} disabled={pending} onChange={event => setOverlayPosition(event.target.value as typeof overlayPosition)}><option value="top-right">右上方</option><option value="top-left">左上方</option></select><small>请在预览中检查是否遮挡脸部或手势，可切换位置。</small></label>}
            <button className="talk-primary" disabled={pending || !selectedCue || (['callout', 'whiteboard'].includes(overlayType) ? !overlayText.trim() : !overlayAsset)} onClick={() => void addOverlay()}><Plus size={15}/> 应用到这句话</button>
            {project.overlays.map(overlay => <article className="talk-cut" key={overlay.id}><div><b>{overlay.type === 'whiteboard' ? '手绘图解' : overlay.type === 'callout' ? '重点卡片' : overlay.type === 'image' ? '图片贴图' : 'B-roll 视频'}</b><span>{overlay.enabled ? '启用' : '关闭'}</span></div><p>{overlay.text || assets.find(asset => asset.id === overlay.assetId)?.name}</p>
              <div className="talk-actions"><button disabled={pending} onClick={() => chooseCue(overlay.cueId)}>编辑</button><button disabled={pending} onClick={() => void update({ overlays: project.overlays.map(item => item.id === overlay.id ? { ...item, enabled: !item.enabled } : item) })}>{overlay.enabled ? '关闭' : '启用'}</button><button disabled={pending} onClick={() => void update({ overlays: project.overlays.filter(item => item.id !== overlay.id) })}>移除</button></div></article>)}
          </>}
        </>}
      </section>
    </main>
    {sourcePreview && result && <div className="talk-dialog-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) { sourceRef.current?.pause(); setSourcePreview(undefined); } }}>
      <section className="talk-dialog" role="dialog" aria-modal="true" aria-labelledby="talk-source-title"><header><div><h2 id="talk-source-title">原片试听</h2><p>{sourcePreview.label}</p></div><button aria-label="关闭原片试听" onClick={() => { sourceRef.current?.pause(); setSourcePreview(undefined); }}><X size={18}/></button></header>
        <video ref={sourceRef} src={result.preview.sourceUrl} controls onPlay={() => playerRef.current?.pause()} onTimeUpdate={event => { if (event.currentTarget.currentTime * 1000 >= sourcePreview.endMs) event.currentTarget.pause(); }}/>
        <p>原片 {(sourcePreview.startMs / 1000).toFixed(2)}–{(sourcePreview.endMs / 1000).toFixed(2)} 秒，包含切点前后语音。</p>
        <button onClick={() => { if (sourceRef.current) { sourceRef.current.currentTime = sourcePreview.startMs / 1000; void sourceRef.current.play().catch(error => setError(messageOf(error))); } }}><Play size={14}/> 重听这段</button>
      </section>
    </div>}
  </div>;
}
