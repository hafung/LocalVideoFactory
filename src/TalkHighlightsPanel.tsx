import { useEffect, useState } from 'react';
import { Play, Plus, Sparkles } from 'lucide-react';
import { talkTimeAt, talkTimeline, type TalkHighlight, type TalkHighlights, type TalkProject } from '../shared/talking-head';
import type { PublishDraft } from '../shared/publishing';
import { PublishPanel } from './PublishPanel';

interface Props {
  project: TalkProject;
  width: number;
  height: number;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  audition: (start: number, end: number, title: string) => void;
  exportClip: (id: string, draft?: PublishDraft) => Promise<boolean>;
  applyAspect: (aspect: '9:16' | '16:9') => void;
}

interface ClipEdit { id?: string; title: string; start: string; end: string }
const sec = (ms: number) => (ms / 1000).toFixed(3);

export function TalkHighlightsPanel({ project, width, height, disabled, onBusy, audition, exportClip, applyAspect }: Props) {
  const [state, setState] = useState<TalkHighlights>();
  const [goal, setGoal] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [edit, setEdit] = useState<ClipEdit>();
  const [finding, setFinding] = useState(false);
  const [saving, setSaving] = useState(false);
  const talk = window.voxweave?.talkingHead;
  const locked = disabled || finding || saving || !state;
  const timeline = talkTimeline(project);

  useEffect(() => {
    let mounted = true;
    if (!talk?.highlights) return;
    void talk.highlights(project.id).then(value => {
      if (mounted) { setState(value); setGoal(value.goal); }
    }).catch(error => { if (mounted) setError(error instanceof Error ? error.message : String(error)); });
    return () => { mounted = false; };
  }, [project.id, talk]);

  async function find() {
    if (!talk || locked) return;
    setFinding(true); onBusy(true); setError(''); setNotice('');
    try {
      const next = await talk.findHighlights(project.id, { revision: project.revision, goal });
      setState(next);
      setNotice(next.items.some(item => !item.confirmed) ? '候选已生成，可以试听或调整首尾。' : '没有新的合适候选，可以手动选择片段。');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setFinding(false); onBusy(false); }
  }

  async function save(operation: () => Promise<TalkHighlights>) {
    setSaving(true); onBusy(true); setError(''); setNotice('');
    try { setState(await operation()); setEdit(undefined); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); onBusy(false); }
  }

  async function deliver(clip: TalkHighlight, draft?: PublishDraft) {
    if (await exportClip(clip.id, draft)) {
      setState(current => current && { ...current, items: current.items.map(item => item.id === clip.id ? { ...item, confirmed: true } : item) });
    }
  }

  return <div className="talk-highlights">
    <label className="talk-field">发布目的<textarea rows={2} value={goal} maxLength={240} disabled={locked}
      onChange={event => setGoal(event.target.value)} placeholder="例如：让新用户看懂如何更换画面"/></label>
    <div className="talk-actions">
      <button className="talk-primary" disabled={locked} onClick={() => void find()}><Sparkles size={14}/> 提取精彩片段</button>
      {finding && <button onClick={() => void talk?.cancelHighlights(project.id)}>取消分析</button>}
      <button disabled={locked} onClick={() => setEdit({ title: '', start: '0', end: sec(Math.min(30_000, project.source.durationMs)) })}><Plus size={14}/> 手动添加</button>
    </div>
    {finding && <p className="talk-hint" role="status">本地模型正在阅读转写并校准片段首尾…</p>}
    {error && <p className="talk-error" role="alert">{error}</p>}
    {notice && <p className="talk-notice" role="status">{notice}</p>}
    {edit && <div className="talk-manual highlight-edit">
      <label>片段标题<input value={edit.title} maxLength={54} disabled={locked} onChange={event => setEdit({ ...edit, title: event.target.value })}/></label>
      <div><label>原片起点（秒）<input type="number" min={0} max={project.source.durationMs / 1000} step="0.001" value={edit.start} disabled={locked}
        onChange={event => setEdit({ ...edit, start: event.target.value })}/></label>
      <label>原片终点（秒）<input type="number" min={0} max={project.source.durationMs / 1000} step="0.001" value={edit.end} disabled={locked}
        onChange={event => setEdit({ ...edit, end: event.target.value })}/></label></div>
      <div className="talk-actions"><button className="talk-primary" disabled={locked || !edit.title.trim() || !edit.start || !edit.end || Number(edit.end) <= Number(edit.start)}
        onClick={() => void save(() => talk!.saveHighlight(project.id, project.revision, { id: edit.id, title: edit.title,
          startMs: Math.round(Number(edit.start) * 1000), endMs: Math.round(Number(edit.end) * 1000) }))}>保存片段</button>
      <button disabled={locked} onClick={() => setEdit(undefined)}>取消</button></div>
    </div>}
    {state?.items.map(clip => {
      const durationMs = talkTimeAt(timeline, clip.endMs) - talkTimeAt(timeline, clip.startMs);
      const related = project.cues.filter(cue => cue.endMs > clip.startMs && cue.startMs < clip.endMs &&
        talkTimeAt(timeline, Math.min(clip.endMs, cue.endMs)) > talkTimeAt(timeline, Math.max(clip.startMs, cue.startMs)));
      const evidence = related.map(cue => (cue.text || cue.originalText).replace(/\|/gu, '')).join('\n');
      return <article className="talk-cut highlight-card" key={clip.id}>
        <div><b>{clip.title}</b><span>{clip.confirmed ? '已确认' : '待试听'}</span></div>
        <small>原片 {sec(clip.startMs)}–{sec(clip.endMs)} 秒 · 剪后 {sec(durationMs)} 秒</small>
        {clip.reason && <p>{clip.reason}</p>}{clip.evidence && <p>转写依据「{clip.evidence}」</p>}
        {related.length > 0 && <details className="highlight-context"><summary>查看片段转写</summary><p>{evidence}</p></details>}
        {durationMs < 500 && <p>原工程的剪辑已移除这段内容，请调整首尾。</p>}
        <div className="talk-actions">
          <button disabled={locked} onClick={() => audition(clip.startMs, clip.endMs, clip.title)}><Play size={13}/> 试听原片</button>
          <button disabled={locked} onClick={() => setEdit({ id: clip.id, title: clip.title, start: sec(clip.startMs), end: sec(clip.endMs) })}>调整首尾</button>
          <button disabled={locked || durationMs < 500} onClick={() => void deliver(clip)}>导出片段 MP4</button>
          <button disabled={locked} onClick={() => void save(() => talk!.removeHighlight(project.id, project.revision, clip.id))}>移除</button>
        </div>
        <PublishPanel title={clip.title} evidence={evidence} durationMs={durationMs} width={width} height={height}
          disabled={locked || durationMs < 500} applyAspect={applyAspect} onExport={draft => void deliver(clip, draft)}/>
      </article>;
    })}
  </div>;
}
