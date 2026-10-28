import { useEffect, useState } from 'react';
import { Download, FolderOpen, Search, Tags, WandSparkles, Trash2, ExternalLink, Check } from 'lucide-react';
import type { MediaAsset, OnlineAsset } from '../shared/library';
import { MusicPanel } from './MusicPanel';

const api = () => window.voxweave!;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const splitTags = (value: string) => [...new Set(value.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean))];

export function LibraryPanel({ changed, initialType, useBgm }: { changed: () => Promise<void>; initialType?: MediaAsset['type']; useBgm?: (asset: MediaAsset) => void }) {
  const [tab, setTab] = useState<'local' | 'online' | 'music'>('local');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'' | MediaAsset['type']>(initialType ?? '');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [preview, setPreview] = useState<MediaAsset>();
  const [key, setKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [onlineType, setOnlineType] = useState<'video' | 'image'>('video');
  const [orientation, setOrientation] = useState<'' | 'portrait' | 'landscape' | 'square'>('');
  const [online, setOnline] = useState<OnlineAsset[]>([]);
  const [translated, setTranslated] = useState('');
  const [page, setPage] = useState(1);
  const [downloaded, setDownloaded] = useState<string[]>([]);

  useEffect(() => { void api().pexelsStatus().then(result => setConfigured(result.configured)).catch(error => setError(messageOf(error))); }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { void api().searchAssets(query, type || undefined).then(items => {
      if (active) setAssets(items);
    }).catch(error => { if (active) setError(messageOf(error)); }); }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, type, revision]);
  useEffect(() => { setConfirmRemove(false); }, [selected]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { setError(messageOf(error)); }
    finally { setBusy(''); }
  }
  async function refresh() { setRevision(value => value + 1); await changed(); }
  async function searchOnline(nextPage = 1) {
    await run('搜索中…', async () => {
      const result = await api().searchPexels({ query, type: onlineType, page: nextPage, orientation: orientation || undefined });
      setOnline(result.items); setTranslated(result.query); setPage(nextPage);
      if (!result.items.length) setNotice('没有找到素材，试试更具体的中英文关键词。');
    });
  }
  function toggle(asset: MediaAsset) {
    setSelected(ids => ids.includes(asset.id) ? ids.filter(id => id !== asset.id) : [...ids, asset.id]);
    if (!selected.length) setTagInput(asset.manualTags.join('，'));
  }

  return <div className="library-panel">
    <div className="library-tabs" role="group" aria-label="素材来源">
      <button aria-pressed={tab === 'local'} onClick={() => setTab('local')}>本地素材</button>
      <button aria-pressed={tab === 'online'} onClick={() => setTab('online')}>Pexels 免费素材</button>
      <button aria-pressed={tab === 'music'} onClick={() => setTab('music')}>免费音乐</button>
    </div>
    <div className="library-feedback" aria-live="polite">{busy || notice}</div>
    {error && <p className="library-error" role="alert">{error}</p>}
    {tab === 'local' ? <>
      <div className="library-toolbar">
        <label className="library-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索本地素材" placeholder="搜索名称、标签（支持中英文）" value={query} onChange={event => { setQuery(event.target.value); setSelected([]); }}/></label>
        <select aria-label="素材类型" value={type} onChange={event => { setType(event.target.value as typeof type); setSelected([]); }}><option value="">全部类型</option><option value="video">视频</option><option value="image">图片</option><option value="audio">音频</option></select>
        <button disabled={!!busy} onClick={() => run('正在导入素材…', async () => {
          const report = await api().importAssets(type || undefined); await refresh();
          setNotice(`已导入 ${report.assets.length} 个素材${report.errors.length ? `，${report.errors.length} 个失败` : ''}`);
          if (report.errors.length) setError(report.errors.map(item => `${item.name}：${item.message}`).join('\n'));
        })}><FolderOpen size={16} aria-hidden="true"/> 批量导入</button>
      </div>
      <p className="library-hint">自动标签来自文件名、目录、媒体属性与中英文词库；不会将本地媒体上传。原文件请保留在原位置。</p>
      <div className="library-selection"><label><input type="checkbox" checked={assets.length > 0 && assets.every(asset => selected.includes(asset.id))} onChange={event => setSelected(event.target.checked ? assets.map(asset => asset.id) : [])}/> 选择当前结果</label><span>已选 {selected.length} · 显示 {assets.length}{assets.length === 100 ? '（请用关键词缩小范围）' : ''}</span></div>
      {selected.length > 0 && <div className="tag-editor">
        <label>人工标签（逗号分隔）<input value={tagInput} maxLength={1000} onChange={event => setTagInput(event.target.value)} placeholder="产品，科技，办公室"/></label>
        <div className="library-toolbar">
          <button disabled={!!busy} onClick={() => run('保存标签…', async () => { await api().updateAssetTags(selected, splitTags(tagInput), 'append'); await refresh(); setNotice('已批量追加人工标签'); })}><Tags size={16} aria-hidden="true"/> 追加标签</button>
          {selected.length === 1 && <button disabled={!!busy} onClick={() => run('保存标签…', async () => { await api().updateAssetTags(selected, splitTags(tagInput), 'replace'); await refresh(); setNotice('人工标签已保存'); })}>替换人工标签</button>}
          <button disabled={!!busy} onClick={() => run('生成自动标签…', async () => { await api().autoTagAssets(selected); await refresh(); setNotice('自动标签已更新，人工标签保留'); })}><WandSparkles size={16} aria-hidden="true"/> 重新自动标记</button>
          <button disabled={!!busy} onClick={() => setConfirmRemove(true)}><Trash2 size={16} aria-hidden="true"/> 移出素材库</button>
        </div>
        {confirmRemove && <div className="library-confirm">移出 {selected.length} 个索引？原文件保留，引用这些素材的工程后续可能无法重新生成。<button disabled={!!busy} onClick={() => run('移出素材…', async () => { await api().removeAssets(selected); setSelected([]); setPreview(undefined); await refresh(); setConfirmRemove(false); })}>确认移出</button><button onClick={() => setConfirmRemove(false)}>取消</button></div>}
      </div>}
      {preview && <div className="asset-preview">
        <div><b>{preview.name}</b><button onClick={() => setPreview(undefined)}>关闭预览</button></div>
        {preview.type === 'image' ? <img src={`voxweave-library://${preview.id}/media`} alt={preview.name}/>
          : preview.type === 'video' ? <video src={`voxweave-library://${preview.id}/media`} controls/>
          : <audio src={`voxweave-library://${preview.id}/media`} controls/>}
        <p>自动标签：{preview.autoTags.join('、') || '暂无'}<br/>人工标签：{preview.manualTags.join('、') || '暂无'}</p>
      </div>}
      <div className="asset-grid">{assets.map(asset => <article className="asset-card" key={asset.id}>
        <label className="asset-select"><input type="checkbox" checked={selected.includes(asset.id)} onChange={() => toggle(asset)}/> 选择</label>
        <button className="asset-thumbnail" onClick={() => setPreview(asset)} aria-label={`预览 ${asset.name}`}>
          {asset.thumbnailPath ? <img loading="lazy" src={`voxweave-library://${asset.id}/thumbnail`} alt=""/> : <span>{asset.type === 'audio' ? '音频 · 点击试听' : '点击预览'}</span>}
        </button>
        <b title={asset.name}>{asset.name}</b><small>{asset.type} {asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)} 秒` : ''} {asset.width ? `${asset.width} × ${asset.height}` : ''}</small>
        <div className="asset-tags">{asset.tags.slice(0, 6).map(tag => <span key={tag}>{tag}</span>)}</div>
        <small>{asset.license.source === 'pexels' ? `Pexels · ${asset.license.author}` : asset.license.source === 'openverse' ? `Openverse · ${asset.license.author}` : '用户导入'}</small>
        {asset.license.source === 'openverse' && <details className="music-credits"><summary>许可与署名</summary><p>{asset.license.note}</p>
          {asset.license.licenseUrl && <button onClick={() => run('打开许可…', () => api().openSource(asset.license.licenseUrl!))}>查看许可</button>}
        </details>}
        {asset.type === 'audio' && useBgm && <button disabled={!!busy} onClick={() => useBgm(asset)}>用作配乐</button>}
        {asset.license.sourceUrl && <button onClick={() => run('打开来源…', () => api().openSource(asset.license.sourceUrl!))}><ExternalLink size={14} aria-hidden="true"/> 查看来源与作者</button>}
      </article>)}</div>
      {!assets.length && <p className="library-empty">{type === 'audio' ? <>还没有匹配的音频。点击「批量导入」添加本地 BGM，或<button onClick={() => setTab('music')}>搜索免费音乐</button>。</> : '还没有匹配的素材。导入本地视频、图片或 BGM，或者切换到 Pexels 搜索。'}</p>}
    </> : tab === 'online' ? <>
      <p className="library-hint">按需搜索和下载图片、视频，授权遵循 Pexels License。<button onClick={() => run('打开 Pexels…', () => api().openSource('https://www.pexels.com/'))}>素材由 Pexels 提供 <ExternalLink size={14} aria-hidden="true"/></button></p>
      <details className="pexels-config"><summary>{configured ? 'Pexels API Key 已配置（点击修改）' : '配置 Pexels API Key'}</summary>
        <div className="pexels-key-row"><label className="key-field"><span>API Key</span><input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="输入 API Key，保存在本机系统加密存储"/></label>
          <button disabled={!!busy || !key.trim()} onClick={() => run('保存设置…', async () => { await api().configurePexels(key); setKey(''); setConfigured(true); setNotice('API Key 已保存'); })}>保存</button>
          <button onClick={() => run('打开申请页面…', () => api().openSource('https://www.pexels.com/api/'))}>申请 Key</button>
          {configured && <button disabled={!!busy} onClick={() => run('清除设置…', async () => { await api().configurePexels(''); setConfigured(false); })}>清除</button>}
        </div>
      </details>
      <form className="library-toolbar" onSubmit={event => { event.preventDefault(); void searchOnline(); }}>
        <label className="library-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索 Pexels 素材" placeholder="如：城市、办公室、海边，或输入英文" value={query} onChange={event => { setQuery(event.target.value); setPage(1); setOnline([]); }}/></label>
        <select aria-label="联网素材类型" value={onlineType} onChange={event => { setOnlineType(event.target.value as typeof onlineType); setPage(1); setOnline([]); }}><option value="video">视频</option><option value="image">图片</option></select>
        <select aria-label="联网素材画幅" value={orientation} onChange={event => { setOrientation(event.target.value as typeof orientation); setPage(1); setOnline([]); }}><option value="">全部画幅</option><option value="portrait">竖屏</option><option value="landscape">横屏</option><option value="square">方形</option></select>
        <button type="submit" disabled={!!busy || !query.trim() || !configured}>搜索</button>
      </form>
      {translated && <p className="library-hint">实际搜索词：{translated} · 可直接输入英文调整结果</p>}
      <div className="asset-grid">{online.map(item => <article className="asset-card" key={item.id}>
        <img className="online-thumbnail" loading="lazy" src={item.thumbnailUrl} alt={item.name}/>
        <b title={item.name}>{item.name}</b><small>{item.width} × {item.height}{item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)} 秒` : ''}</small>
        <button onClick={() => run('打开来源…', () => api().openSource(item.sourceUrl))}>{item.author} · Pexels <ExternalLink size={14} aria-hidden="true"/></button>
        <button disabled={!!busy || downloaded.includes(item.id)} onClick={() => run(`下载 ${item.name}…`, async () => {
          await api().downloadPexels(item.id); setDownloaded(ids => [...ids, item.id]); await refresh(); setNotice('已下载到本地素材库');
        })}>{downloaded.includes(item.id) ? <Check size={16} aria-hidden="true"/> : <Download size={16} aria-hidden="true"/>}{downloaded.includes(item.id) ? '已入库' : '下载入库'}</button>
      </article>)}</div>
      {online.length > 0 && <div className="library-toolbar"><button disabled={!!busy || page <= 1} onClick={() => searchOnline(page - 1)}>上一页</button><span>第 {page} 页</span><button disabled={!!busy || online.length < 12} onClick={() => searchOnline(page + 1)}>下一页</button></div>}
    </> : <MusicPanel changed={refresh} useBgm={useBgm}/>}
  </div>;
}
