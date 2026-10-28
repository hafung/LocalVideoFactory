import { useRef, useState } from 'react';
import { Download, ExternalLink, Headphones } from 'lucide-react';
import type { MediaAsset, MusicSearchRequest, MusicSearchResult, OnlineMusic } from '../shared/library';

const api = () => window.voxweave!;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const licenseName = (item: OnlineMusic) => `${item.license === 'cc0' ? 'CC0' : 'CC BY'} ${item.licenseVersion}`;

export function MusicPanel({ changed, useBgm }: { changed: () => Promise<void>; useBgm?: (asset: MediaAsset) => void }) {
  const [query, setQuery] = useState('钢琴');
  const [license, setLicense] = useState<MusicSearchRequest['license']>('cc0');
  const [result, setResult] = useState<MusicSearchResult>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<OnlineMusic>();
  const [downloaded, setDownloaded] = useState<Record<string, MediaAsset>>({});
  const pending = useRef(false);

  async function run(label: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (error) { setError(messageOf(error)); }
    finally { pending.current = false; setBusy(''); }
  }
  async function search(page = 1, words = query) {
    await run('正在搜索免费音乐…', async () => {
      setPreview(undefined);
      const found = await api().searchMusic({ query: words, license, page });
      setResult(found);
      if (!found.items.length) setNotice('这一页没有可用音乐。可换搜索词、翻页，或选择包含 CC BY 的曲目。');
    });
  }
  async function download(item: OnlineMusic) {
    const cached = downloaded[item.id];
    const asset = cached ?? await api().downloadMusic(item.id);
    if (!cached) setDownloaded(items => ({ ...items, [item.id]: asset }));
    await changed();
    return asset;
  }
  function reset() { setResult(undefined); setPreview(undefined); setError(''); setNotice(''); }

  return <section className="music-panel" aria-label="免费背景音乐">
    <p className="library-hint">通过 Openverse 搜索音乐与循环片段，无需填写 API Key。默认只显示 CC0；CC BY 曲目需要署名、附许可链接并注明修改。</p>
    <form className="library-toolbar" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label className="library-search"><input aria-label="搜索免费音乐" maxLength={150} placeholder="如：钢琴、舒缓、励志，或输入英文" value={query} disabled={!!busy} onChange={event => { setQuery(event.target.value); reset(); }}/></label>
      <select aria-label="音乐许可" value={license} disabled={!!busy} onChange={event => { setLicense(event.target.value as typeof license); reset(); }}>
        <option value="cc0">CC0 · 无需署名</option><option value="cc0-by">CC0 + CC BY · 含需署名曲目</option>
      </select>
      <button type="submit" disabled={!!busy || !query.trim()}>搜索音乐</button>
    </form>
    <div className="music-suggestions">{['钢琴', '舒缓', '励志', 'ambient', 'acoustic', 'corporate'].map(words =>
      <button key={words} disabled={!!busy} onClick={() => { setQuery(words); void search(1, words); }}>{words}</button>)}</div>
    <div className="library-feedback" aria-live="polite">{busy || notice}</div>
    {error && <p className="library-error" role="alert">{error}</p>}
    {result && <p className="library-hint">实际搜索词：{result.query} · 过滤不足 10 秒的片段</p>}
    {preview && <div className="asset-preview music-preview">
      <div><b>{preview.name} · {preview.author}</b><button onClick={() => setPreview(undefined)}>关闭试听</button></div>
      <audio key={preview.id} src={downloaded[preview.id] ? `voxweave-library://${downloaded[preview.id].id}/media` : preview.previewUrl} controls autoPlay preload="none" onError={() => setError('该音乐暂时无法试听，可尝试下载入库或选择其他曲目。')}/>
    </div>}
    <div className="asset-grid">{result?.items.map(item => <article className="asset-card music-card" key={item.id}>
      <b title={item.name}>{item.name}</b>
      <small>{item.author} · {(item.durationMs / 1000).toFixed(1)} 秒 · {item.provider}</small>
      <span className="music-license">{licenseName(item)} · {item.license === 'cc0' ? '无需署名' : '需署名'}</span>
      <div className="asset-tags">{item.tags.slice(0, 5).map(tag => <span key={tag}>{tag}</span>)}</div>
      <button onClick={() => { setError(''); setPreview(item); }}><Headphones size={16} aria-hidden="true"/> 试听</button>
      <button disabled={!!busy || !!downloaded[item.id]} onClick={() => void run(`正在下载 ${item.name}…`, async () => {
        await download(item); setNotice('已下载到音频素材库，可回到背景音乐下拉框选择。');
      })}><Download size={16} aria-hidden="true"/>{downloaded[item.id] ? '已入库' : '下载入库'}</button>
      {useBgm && <button disabled={!!busy} onClick={() => void run('正在设置配乐…', async () => {
        const asset = await download(item); setPreview(undefined); useBgm(asset);
      })}>用作配乐</button>}
      <details className="music-credits"><summary>来源、许可与署名</summary>
        <p>{item.attribution || `“${item.name}” — ${item.author}. ${item.sourceUrl} · ${item.licenseUrl}`}</p>
        {item.license === 'by' && <p>发布视频时请保留以上署名及链接，并注明剪辑、混音等修改。</p>}
        <button onClick={() => void run('打开来源…', () => api().openSource(item.sourceUrl))}><ExternalLink size={14} aria-hidden="true"/> 查看原始来源</button>
        <button onClick={() => void run('打开许可…', () => api().openSource(item.licenseUrl))}>查看许可</button>
      </details>
    </article>)}</div>
    {result && result.pageCount > 1 && <div className="library-toolbar">
      <button disabled={!!busy || result.page <= 1} onClick={() => void search(result.page - 1)}>上一页</button>
      <span>第 {result.page} / {result.pageCount} 页</span>
      <button disabled={!!busy || result.page >= result.pageCount} onClick={() => void search(result.page + 1)}>下一页</button>
    </div>}
    <p className="library-hint">由 Openverse 提供检索，未经 Openverse 背书或认证。许可信息来自来源网站，请在发布前查看原始来源。
      <button onClick={() => void run('打开 Openverse…', () => api().openSource('https://openverse.org/'))}>Openverse <ExternalLink size={14} aria-hidden="true"/></button>
    </p>
  </section>;
}
