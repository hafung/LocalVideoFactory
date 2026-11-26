import { useState } from 'react';
import { Copy, Package, Sparkles } from 'lucide-react';
import { publishCopy, publishingPlatforms, type PublishDraft, type PublishingPlatform } from '../shared/publishing';
import './publishing.css';

interface Props {
  title?: string;
  evidence: string;
  durationMs: number;
  width: number;
  height: number;
  disabled: boolean;
  playhead?: () => number | undefined;
  applyAspect?: (aspect: '9:16' | '16:9') => void;
  onExport: (draft: PublishDraft) => void;
}

export function PublishPanel({ title = '', evidence, durationMs, width, height, disabled, playhead, applyAspect, onExport }: Props) {
  const [draft, setDraft] = useState<PublishDraft>(() => ({ platform: 'general', frameMs: Math.min(1000, Math.round(durationMs / 2)),
    coverTitle: title.slice(0, 54), title: title.slice(0, 120), description: '', tags: '' }));
  const [drafting, setDrafting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [quote, setQuote] = useState('');
  const preset = publishingPlatforms[draft.platform];
  const aspect = width === height ? '1:1' : width > height ? '16:9' : '9:16';
  const suggested = preset.aspect;
  const differentAspect = suggested !== 'source' && suggested !== aspect;
  const maxTime = Math.max(0, durationMs - 1);
  const frameMs = Math.min(maxTime, draft.frameMs);
  const change = (value: Partial<PublishDraft>) => setDraft(current => ({ ...current, ...value }));

  async function copy() {
    setError(''); setNotice('');
    try { await navigator.clipboard.writeText(publishCopy(draft)); setNotice('发布文案已复制'); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }

  async function suggest() {
    setDrafting(true); setError(''); setNotice(''); setQuote('');
    try {
      const result = await window.voxweave!.suggestPublishCopy({ platform: draft.platform, evidence: evidence.trim().slice(0, 3600) });
      change({ title: result.title, description: result.description, tags: result.tags, coverTitle: result.title.slice(0, 54) });
      setQuote(result.quote);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setDrafting(false); }
  }

  return <details className="publish-panel">
    <summary><Package size={16}/> 导出发布包</summary>
    <fieldset disabled={disabled || drafting}>
      <label>发布平台<select value={draft.platform} onChange={event => change({ platform: event.target.value as PublishingPlatform })}>
        {Object.entries(publishingPlatforms).map(([value, platform]) => <option key={value} value={value}>{platform.label}</option>)}
      </select></label>
      {differentAspect && <div className="publish-hint"><span>建议视频画幅 {suggested} · 当前 {aspect}</span>
        {applyAspect && <button type="button" onClick={() => applyAspect(suggested)}>应用推荐画幅</button>}</div>}
      <label>封面帧（成片秒数）<input type="number" min="0" max={maxTime / 1000} step="0.001" value={frameMs / 1000}
        onChange={event => change({ frameMs: Math.round(Math.max(0, Number(event.target.value)) * 1000) })}/></label>
      {playhead && <button className="publish-use-frame" type="button" onClick={() => {
        const at = playhead(); if (at !== undefined && Number.isFinite(at)) change({ frameMs: Math.min(maxTime, Math.max(0, Math.round(at * 1000))) });
      }}>用预览当前位置</button>}
      <label>封面标题<input value={draft.coverTitle} maxLength={54} onChange={event => change({ coverTitle: event.target.value })}/></label>
      <label>发布标题<input value={draft.title} maxLength={120} onChange={event => change({ title: event.target.value })}/></label>
      <label>简介<textarea rows={2} value={draft.description} maxLength={2000} onChange={event => change({ description: event.target.value })}/></label>
      <label>话题<input value={draft.tags} maxLength={300} placeholder="用空格分隔" onChange={event => change({ tags: event.target.value })}/></label>
      <p className="publish-hint">{preset.hint}</p>
      <div className="publish-actions">
        <button type="button" disabled={!window.voxweave?.suggestPublishCopy || evidence.trim().length < 4} onClick={() => void suggest()}><Sparkles size={14}/> 起草文案</button>
        <button type="button" disabled={!publishCopy(draft)} onClick={() => void copy()}><Copy size={14}/> 复制文案</button>
        <button type="button" className="publish-primary" onClick={() => onExport({ ...draft, frameMs })}><Package size={14}/> 保存 MP4、封面和文案</button>
      </div>
    </fieldset>
    {drafting && <p className="publish-hint" role="status">本地模型正在起草文案…</p>}
    {quote && <p className="publish-hint">依据原文「{quote}」。请核对措辞和数字后再使用。</p>}
    {notice && <p className="publish-hint" role="status">{notice}</p>}
    {error && <p className="publish-error" role="alert">{error}</p>}
  </details>;
}
