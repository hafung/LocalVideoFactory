import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Search, Tags, WandSparkles, Trash2, ExternalLink, Check } from 'lucide-react';
import { isOnlineSource, onlineSourceInfo, PIXABAY_VIDEO_PAGE, type MediaAsset, type OnlineSearchResult } from '../shared/library';
import { OnlineCredits, OnlineSourceBanner, onlineOperation, useOnlineSources } from './OnlineMedia';
import { MusicPanel } from './MusicPanel';

const api = () => window.voxweave!;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const splitTags = (value: string) => [...new Set(value.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean))];

type TagEditorLocation = 'card' | 'preview';

export function LibraryPanel({ changed, initialType, initialTab = 'local', useBgm, onOnlineSettings }: {
  changed: () => Promise<void>; initialType?: MediaAsset['type']; initialTab?: 'local' | 'online'; useBgm?: (asset: MediaAsset) => void; onOnlineSettings: () => void;
}) {
  const [tab, setTab] = useState<'local' | 'online' | 'music'>(initialTab);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'' | MediaAsset['type']>(initialType ?? '');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchTags, setBatchTags] = useState('');
  const [tagEditor, setTagEditor] = useState<{ id: string; location: TagEditorLocation }>();
  const tagEditorTrigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const preview = assets.find(asset => asset.id === previewId);
  const { sources } = useOnlineSources(tab === 'online');
  const [onlineType, setOnlineType] = useState<'video' | 'image'>('video');
  const [orientation, setOrientation] = useState<'' | 'portrait' | 'landscape' | 'square'>('');
  const [result, setResult] = useState<OnlineSearchResult>();
  const [onlinePreviewId, setOnlinePreviewId] = useState<string>();
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const onlineController = useRef<AbortController>(undefined);
  const onlinePreview = result?.items.find(item => item.id === onlinePreviewId);

  useEffect(() => () => onlineController.current?.abort(), []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { void api().searchAssets(query, type || undefined).then(items => {
      if (active) setAssets(items);
    }).catch(error => { if (active) setError(messageOf(error)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, type, revision]);
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { setError(messageOf(error)); }
    finally { setBusy(''); }
  }
  async function refresh() { setRevision(value => value + 1); await changed(); }
  async function importMedia(kind?: MediaAsset['type']) {
    await run('正在导入素材…', async () => {
      const report = await api().importAssets(kind);
      if (report.assets.length) {
        if (tab === 'online') { setTab('local'); setType(kind ?? ''); setQuery(''); selectAssets([]); }
        await refresh();
        setNotice(`已导入 ${report.assets.length} 个素材${report.errors.length ? `，${report.errors.length} 个失败` : ''}`);
      }
      if (report.errors.length) setError(report.errors.map(item => `${item.name}：${item.message}`).join('\n'));
    });
  }
  async function runOnline(label: string, action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    onlineController.current = controller;
    await run(label, async () => {
      try { await action(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) throw error;
        setNotice('已取消');
      }
      finally { onlineController.current = undefined; }
    });
  }
  async function searchOnline(nextPage = 1) {
    if (nextPage > 100) return;
    await runOnline('搜索中…', async signal => {
      const found = await onlineOperation(signal, id => api().searchOnlineMedia(id,
        { query, types: [onlineType], page: nextPage, orientation: orientation || undefined }));
      signal.throwIfAborted();
      setResult(found);
      setOnlinePreviewId(undefined);
      if (!found.items.length) setNotice(found.notice ?? '没有找到素材，试试更具体的中英文关键词。');
    });
  }
  function selectAssets(ids: string[]) {
    setSelected(ids);
    setBatchTags('');
    setConfirmRemove(false);
  }
  function showPreview(id?: string) {
    if (tagEditor?.location === 'preview') setTagEditor(undefined);
    setPreviewId(id);
  }
  function switchTab(value: typeof tab) {
    if (value === tab) return;
    setTagEditor(undefined);
    setTab(value);
  }
  function renderTagEditor(asset: MediaAsset, location: TagEditorLocation) {
    const editing = tagEditor?.id === asset.id && tagEditor.location === location;
    function close() {
      const trigger = tagEditorTrigger.current;
      setTagEditor(undefined);
      requestAnimationFrame(() => trigger?.focus());
    }
    return <>
      <button type="button" className="asset-edit-tags" hidden={editing} disabled={!!busy}
        aria-label={`编辑标签 · ${asset.name}`} onClick={event => {
          tagEditorTrigger.current = event.currentTarget;
          setTagEditor({ id: asset.id, location });
        }}><Tags size={16} aria-hidden="true"/> 编辑标签</button>
      {editing && <ManualTagEditor key={asset.id} tags={asset.manualTags} busy={!!busy} onCancel={close}
        onSave={tags => void run('正在保存标签…', async () => {
          await api().updateAssetTags([asset.id], tags, 'replace');
          await refresh();
          close();
          setNotice('已保存人工标签');
        })}/>}
    </>;
  }
  function appendBatchTags() {
    const tags = splitTags(batchTags);
    if (busy || selected.length < 2 || !tags.length) return;
    void run('正在追加标签…', async () => {
      await api().updateAssetTags(selected, tags, 'append');
      setBatchTags('');
      await refresh();
      setNotice(`已给 ${selected.length} 条素材追加标签`);
    });
  }

  return <div className="library-panel">
    <div className="library-tabs" role="group" aria-label="素材来源">
      <button aria-pressed={tab === 'local'} disabled={!!busy} onClick={() => switchTab('local')}>本地素材</button>
      <button aria-pressed={tab === 'online'} disabled={!!busy} onClick={() => switchTab('online')}>在线素材</button>
      <button aria-pressed={tab === 'music'} disabled={!!busy} onClick={() => switchTab('music')}>免费音乐</button>
    </div>
    <div className="library-feedback" aria-live="polite">{busy || notice}</div>
    {error && <p className="library-error" role="alert">{error}</p>}
    {tab === 'local' ? <>
      <div className="library-toolbar">
        <label className="library-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索本地素材" placeholder="搜索名称、标签（支持中英文）" value={query} onChange={event => { setQuery(event.target.value); selectAssets([]); setTagEditor(undefined); }}/></label>
        <select aria-label="素材类型" value={type} onChange={event => { setType(event.target.value as typeof type); selectAssets([]); setTagEditor(undefined); }}><option value="">全部类型</option><option value="video">视频</option><option value="image">图片</option><option value="audio">音频</option></select>
        <button disabled={!!busy} onClick={() => void importMedia(type || undefined)}><FolderOpen size={16} aria-hidden="true"/> 批量导入</button>
      </div>
      <p className="library-hint">自动标签来自文件名、目录、媒体属性与中英文词库；不会将本地媒体上传。原文件请保留在原位置。</p>
      <div className="library-selection"><label><input type="checkbox" disabled={!!busy || !assets.length}
        checked={assets.length > 0 && assets.every(asset => selected.includes(asset.id))}
        onChange={event => selectAssets(event.target.checked ? assets.map(asset => asset.id) : [])}/> 选择当前结果</label>
        <span>已选 {selected.length} · 显示 {assets.length}{assets.length === 100 ? '（请用关键词缩小范围）' : ''}</span></div>
      {selected.length > 0 && <div className="library-selection-actions">
        {selected.length > 1 && <form className="library-batch-tags" onSubmit={event => {
          event.preventDefault();
          appendBatchTags();
        }}>
          <label>批量追加标签<input value={batchTags} disabled={!!busy} maxLength={1000}
            onChange={event => setBatchTags(event.target.value)} placeholder="用逗号分隔，例如：城市，夜景"/></label>
          <button type="submit" disabled={!!busy || !splitTags(batchTags).length}>为 {selected.length} 条追加</button>
        </form>}
        <div className="library-toolbar">
          <button disabled={!!busy} onClick={() => run('生成自动标签…', async () => { await api().autoTagAssets(selected); await refresh(); setNotice('自动标签已更新，人工标签保留'); })}><WandSparkles size={16} aria-hidden="true"/> 重新自动标记</button>
          <button disabled={!!busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} aria-hidden="true"/> 移出素材库</button>
        </div>
        {confirmRemove && <div className="library-confirm">移出 {selected.length} 个索引？原文件保留，引用这些素材的工程后续可能无法重新生成。<button disabled={!!busy} onClick={() => run('移出素材…', async () => {
          await api().removeAssets(selected);
          selectAssets([]);
          if (previewId && selected.includes(previewId)) showPreview();
          if (tagEditor && selected.includes(tagEditor.id)) setTagEditor(undefined);
          await refresh();
        })}>确认移出</button><button onClick={() => setConfirmRemove(false)}>取消</button></div>}
      </div>}
      {preview && <div className="asset-preview">
        <div><b>{preview.name}</b><button type="button" onClick={() => showPreview()}>关闭预览</button></div>
        {preview.type === 'image' ? <img src={`voxweave-library://${preview.id}/media`} alt={preview.name}/>
          : preview.type === 'video' ? <video src={`voxweave-library://${preview.id}/media`} controls/>
          : <audio src={`voxweave-library://${preview.id}/media`} controls/>}
        <p>自动标签：{preview.autoTags.join('、') || '暂无'}<br/>人工标签：{preview.manualTags.join('、') || '暂无'}</p>
        {renderTagEditor(preview, 'preview')}
      </div>}
      <div className="asset-grid">{assets.map(asset => <article className="asset-card" key={asset.id}>
        <label className="asset-select"><input type="checkbox" disabled={!!busy} checked={selected.includes(asset.id)}
          onChange={event => selectAssets(event.target.checked ? [...selected, asset.id] : selected.filter(id => id !== asset.id))}/> 选择</label>
        <button className="asset-thumbnail" onClick={() => showPreview(asset.id)} aria-label={`预览 ${asset.name}`}>
          {asset.thumbnailPath ? <img loading="lazy" src={`voxweave-library://${asset.id}/thumbnail`} alt=""/> : <span>{asset.type === 'audio' ? '音频 · 点击试听' : '点击预览'}</span>}
        </button>
        <b title={asset.name}>{asset.name}</b><small>{asset.type} {asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)} 秒` : ''} {asset.width ? `${asset.width} × ${asset.height}` : ''}</small>
        <div className="asset-tags">{asset.tags.slice(0, 6).map(tag => <span key={tag}>{tag}</span>)}</div>
        {renderTagEditor(asset, 'card')}
        <small>{isOnlineSource(asset.license.source) ? onlineSourceInfo[asset.license.source].name : asset.license.source === 'openverse' ? `Openverse · ${asset.license.author}` : '用户导入'}</small>
        {asset.license.source === 'openverse' && <details className="music-credits"><summary>许可与署名</summary><p>{asset.license.note}</p>
          {asset.license.licenseUrl && <button onClick={() => run('打开许可…', () => api().openSource(asset.license.licenseUrl!))}>查看许可</button>}
        </details>}
        {asset.type === 'audio' && useBgm && <button disabled={!!busy} onClick={() => useBgm(asset)}>用作配乐</button>}
        {isOnlineSource(asset.license.source) && <OnlineCredits license={asset.license}/>}
        {asset.additionalLicenses?.map((license, index) => <OnlineCredits key={index} license={license}/>)}
        {asset.license.sourceUrl && !isOnlineSource(asset.license.source) && <button onClick={() => run('打开来源…', () => api().openSource(asset.license.sourceUrl!))}><ExternalLink size={14} aria-hidden="true"/> 查看来源与作者</button>}
      </article>)}</div>
      {!assets.length && <p className="library-empty">{type === 'audio' ? <>还没有匹配的音频。点击「批量导入」添加本地 BGM，或<button onClick={() => setTab('music')}>搜索免费音乐</button>。</> : '还没有匹配的素材。导入本地视频、图片或 BGM，或者切换到在线素材搜索。'}</p>}
    </> : tab === 'online' ? <>
      <OnlineSourceBanner source={result?.source} sources={sources} types={[onlineType]} onSettings={onOnlineSettings}/>
      <form className="library-toolbar" onSubmit={event => { event.preventDefault(); if (!busy && query.trim()) void searchOnline(); }}>
        <label className="library-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索在线素材" placeholder="如：城市、办公室、海边" maxLength={150}
          disabled={!!busy} value={query} onChange={event => { setQuery(event.target.value); setResult(undefined); }}/></label>
        <select aria-label="联网素材类型" disabled={!!busy} value={onlineType} onChange={event => { setOnlineType(event.target.value as typeof onlineType); setResult(undefined); }}>
          <option value="video">视频</option><option value="image">图片</option>
        </select>
        <select aria-label="联网素材画幅" disabled={!!busy} value={orientation} onChange={event => { setOrientation(event.target.value as typeof orientation); setResult(undefined); }}>
          <option value="">全部画幅</option><option value="portrait">竖屏</option><option value="landscape">横屏</option><option value="square">方形</option>
        </select>
        <button type="submit" disabled={!!busy || !query.trim()}>搜索</button>
        {busy && onlineController.current && <button type="button" onClick={() => onlineController.current?.abort()}>取消</button>}
      </form>
      <details className="online-alternatives">
        <summary>从网页下载后导入</summary>
        <div className="library-toolbar">
          <button disabled={!!busy} onClick={() => run('打开 Pixabay…', () => api().openSource(PIXABAY_VIDEO_PAGE))}>去 Pixabay 找素材 <ExternalLink size={14} aria-hidden="true"/></button>
          <button disabled={!!busy} onClick={() => void importMedia()}><FolderOpen size={16} aria-hidden="true"/> 导入已下载的素材</button>
        </div>
      </details>
      {result?.query && result.query !== query && <p className="library-hint">实际搜索词：{result.query}</p>}
      {onlinePreview && <div className="asset-preview">
        <div><b>{onlinePreview.name}</b><button onClick={() => setOnlinePreviewId(undefined)}>关闭预览</button></div>
        {onlinePreview.type === 'image' ? <img src={onlinePreview.previewUrl} alt={onlinePreview.name}/>
          : <video key={onlinePreview.id} src={onlinePreview.previewUrl} controls preload="metadata"/>}
        <OnlineCredits license={onlinePreview.license}/>
      </div>}
      <div className="asset-grid">{result?.items.map(item => <article className="asset-card" key={item.id}>
        <button className="asset-thumbnail" aria-label={`预览 ${item.name}`} onClick={() => setOnlinePreviewId(item.id)}>
          <img loading="lazy" src={item.thumbnailUrl} alt=""/>
        </button>
        <b title={item.name}>{item.name}</b><small>{item.width} × {item.height}{item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}</small>
        <OnlineCredits license={item.license}/>
        <button disabled={!!busy || downloaded.includes(item.id)} onClick={() => runOnline('正在下载素材…', async signal => {
          const found = await onlineOperation(signal, id => api().downloadOnlineMedia(id, item.id));
          signal.throwIfAborted();
          if ('alternatives' in found) {
            if (found.alternatives.items.length) {
              setResult(found.alternatives);
              setOnlinePreviewId(undefined);
            }
            setNotice(`${found.alternatives.notice ?? ''}${found.alternatives.items.length ? '。请选择其他素材。' : '。'}`);
            return;
          }
          setDownloaded(ids => [...ids, item.id]); await refresh(); setNotice('已下载到本地素材库');
        })}>{downloaded.includes(item.id) ? <Check size={16} aria-hidden="true"/> : <Download size={16} aria-hidden="true"/>}{downloaded.includes(item.id) ? '已入库' : '下载入库'}</button>
      </article>)}</div>
      {!!result?.items.length && <div className="library-toolbar">
        <button disabled={!!busy || result.page <= 1} onClick={() => searchOnline(result.page - 1)}>上一页</button>
        <span>第 {result.page} 页</span><button disabled={!!busy || !result.hasMore || result.page >= 100} onClick={() => searchOnline(result.page + 1)}>下一页</button>
      </div>}
    </> : <MusicPanel changed={refresh} useBgm={useBgm}/>}
  </div>;
}

function ManualTagEditor({ tags, busy, onSave, onCancel }: {
  tags: string[]; busy: boolean; onSave: (tags: string[]) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(tags.join('，'));
  const nextTags = splitTags(draft);
  const dirty = nextTags.length !== tags.length || nextTags.some((tag, index) => tag !== tags[index]);
  return <form className="asset-tag-editor" onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.stopPropagation();
    if (!busy) onCancel();
  }} onSubmit={event => {
    event.preventDefault();
    if (dirty && !busy) onSave(nextTags);
  }}>
    <label>人工标签<input autoFocus disabled={busy} value={draft} maxLength={1000}
      onChange={event => setDraft(event.target.value)} placeholder="用逗号分隔，例如：城市，夜景"/></label>
    <div className="asset-tag-actions">
      <button type="submit" disabled={!dirty || busy}>保存标签</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </form>;
}
