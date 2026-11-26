import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { onlineSourceInfo, type AssetLicense, type CoverrTier, type OnlineSource, type OnlineSourceStatus, type OnlineType } from '../shared/library';
import coverrLogo from './assets/coverr-logo.svg';

const desktop = () => window.voxweave!;
const tierNames: Record<CoverrTier, string> = { demo: 'Demo', production: 'Production', enterprise: 'Enterprise' };
const states: Record<OnlineSourceStatus['state'], string> = {
  ready: '已配置', missing: '未配置', invalid: '密钥无效或权限不足', unavailable: '无法读取本机密钥', cooldown: '限流暂停'
};

export function onlineOperation<T>(signal: AbortSignal, operation: (id: string) => Promise<T>) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const cancel = () => { void desktop().cancelOnlineMedia(id).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  return operation(id).finally(() => signal.removeEventListener('abort', cancel));
}

export function useOnlineSources(enabled = true) {
  const [sources, setSources] = useState<OnlineSourceStatus[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !window.voxweave) return;
    let active = true;
    void desktop().onlineSourceStatus().then(value => { if (active) setSources(value); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [enabled]);
  return { sources, setSources, error };
}

function SourceLink({ url, children, className }: { url: string; children: React.ReactNode; className?: string }) {
  return <button type="button" className={className ?? 'text-action'} onClick={() => void desktop().openSource(url).catch(() => undefined)}>
    {children}<ExternalLink size={12} aria-hidden="true"/>
  </button>;
}

export function OnlineSourceBanner({ source, sources, types, onSettings }: {
  source?: OnlineSource; sources: OnlineSourceStatus[]; types: OnlineType[]; onSettings: () => void;
}) {
  const next = sources.find(status => status.state === 'ready' && types.some(type => status.types.includes(type)))?.source;
  const displayed = source ?? next;
  if (!displayed) return null;
  return <div className="online-source-banner" aria-live="polite">
    <span>{source ? '当前使用' : '优先搜索'} <SourceLink url={onlineSourceInfo[displayed].home}>{onlineSourceInfo[displayed].name}</SourceLink></span>
    <button type="button" className="text-action" onClick={onSettings}>{displayed === 'wikimedia' ? '添加其他来源的 API Key' : '管理在线来源'}</button>
  </div>;
}

export function OnlineCredits({ license }: { license: AssetLicense }) {
  const author = license.author || '作者未注明';
  return <div className="online-credits">
    {license.source === 'coverr' && <SourceLink url={onlineSourceInfo.coverr.home} className="online-brand-link">
      <img src={coverrLogo} alt="Coverr"/>
    </SourceLink>}
    {license.sourceUrl && <SourceLink url={license.sourceUrl}>原始素材页</SourceLink>}
    {license.authorUrl ? <SourceLink url={license.authorUrl}>{author}</SourceLink> : <span>{author}</span>}
    {license.licenseUrl ? <SourceLink url={license.licenseUrl}>{license.licenseName ?? '查看许可'}</SourceLink>
      : license.licenseName && <span>{license.licenseName}</span>}
    {license.attributionRequired && <small className="online-credit-note">需署名。{license.note}</small>}
  </div>;
}

export function OnlineSourceSettings() {
  const { sources, setSources, error } = useOnlineSources();
  return <div className="online-source-settings">
    {error && <p className="field-error" role="alert">{error}</p>}
    {sources.map(status => <SourceSettingsRow key={status.source} status={status} onChange={setSources}/>)}
  </div>;
}

function SourceSettingsRow({ status, onChange }: { status: OnlineSourceStatus; onChange: (sources: OnlineSourceStatus[]) => void }) {
  const { source } = status;
  const info = onlineSourceInfo[source];
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tier = status.tier ?? 'demo';
  const description = {
    pexels: '视频和图片 · 主动搜索、自动补画面',
    pixabay: '视频和图片 · 主动搜索 · 搜索结果缓存 24 小时',
    coverr: `视频 · 主动搜索${status.automatic ? '、自动补画面' : ' · Demo 需署名，Production 或 Enterprise 可自动补画面'}`,
    wikimedia: '视频和图片 · 主动搜索 · CC0 或明确标为公有领域的素材可自动补画面'
  }[source];

  async function save(value?: string, nextTier?: CoverrTier) {
    if (source === 'wikimedia') return;
    setBusy(true);
    setError('');
    try {
      onChange(await desktop().configureOnlineSource({ source, key: value, tier: nextTier }));
      setKey('');
    } catch (error) { setError(error instanceof Error ? error.message : '无法保存在线来源设置'); }
    finally { setBusy(false); }
  }

  return <div className="online-source-setting">
    <div><strong>{info.name}</strong><span>{source === 'wikimedia' && status.state === 'ready' ? '可用 · 无需 Key' : states[status.state]}
      {status.retryAt ? ` · ${new Date(status.retryAt).toLocaleTimeString()} 后重试` : ''}</span></div>
    <p>{description}</p>
    {source !== 'wikimedia' && <form onSubmit={event => { event.preventDefault(); if (key.trim()) void save(key); }}>
      <input type="password" aria-label={`${info.name} API Key`} placeholder="API Key" autoComplete="off" maxLength={300} disabled={busy}
        value={key} onChange={event => setKey(event.target.value)}/>
      <button type="submit" className="secondary-button" disabled={busy || !key.trim()}>保存</button>
      {status.storedKey && <button type="button" className="text-action" disabled={busy} onClick={() => void save('')}>清除</button>}
      {info.keyPage && <SourceLink url={info.keyPage}>获取 Key</SourceLink>}
      {source === 'coverr' && <label>Key 档位 <select value={tier} disabled={busy} onChange={event => void save(undefined, event.target.value as CoverrTier)}>
        {Object.entries(tierNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>}
    </form>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
