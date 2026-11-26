import { useEffect, useId, useRef, useState } from 'react';
import { Check, ExternalLink, Film, Globe, Image, Plus, Search, Type, Undo2 } from 'lucide-react';
import type { Scene } from '../shared/edit-plan';
import type { OnlineAsset } from '../shared/library';
import type { SceneCandidate, SceneCandidateResult, SceneChoice } from '../shared/scene-candidates';
import { Modal } from './Modal';
import './scene-picker.css';

const sources = [
  { id: 'local', label: '本地素材', icon: Image },
  { id: 'online', label: 'Pexels 在线素材', icon: Globe }
] as const;

type Source = typeof sources[number]['id'];
type SearchRequest = { query: string; endIndex: number; revision: number };

function candidateKey(candidate: SceneCandidate) {
  const start = candidate.choice.type === 'asset' ? candidate.choice.sourceInMs ?? 0 : 0;
  return `${candidate.asset.id}-${start}`;
}

function onlinePriority(item: OnlineAsset, durationMs: number) {
  if (item.type === 'image') return 1;
  return (item.durationMs ?? 0) >= durationMs ? 0 : 2;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ScenePicker({ projectId, scenes, playbackRate, onClose, onOpenOnlineLibrary, onAssetsChanged, onApply }: {
  projectId: string;
  scenes: Scene[];
  playbackRate: number;
  onClose: () => void;
  onOpenOnlineLibrary: () => void;
  onAssetsChanged: () => Promise<void>;
  onApply: (choice: SceneChoice) => Promise<void>;
}) {
  const [source, setSource] = useState<Source>('local');
  const [query, setQuery] = useState('');
  const [request, setRequest] = useState<SearchRequest>({ query: '', endIndex: 0, revision: 0 });
  const [localResult, setLocalResult] = useState<{ request: SearchRequest; result?: SceneCandidateResult; error?: string }>();
  const [onlineResult, setOnlineResult] = useState<{ keyword: string; revision: number; items?: OnlineAsset[]; error?: string; needsKey?: boolean }>();
  const [localSelection, setLocalSelection] = useState<string>();
  const [onlineSelection, setOnlineSelection] = useState<string>();
  const [pending, setPending] = useState<'apply' | 'download'>();
  const [applyError, setApplyError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const desktop = window.voxweave!;
  const { endIndex, revision: onlineRevision } = request;
  const scene = scenes[0];
  const throughSceneId = endIndex ? scenes[endIndex].id : undefined;
  const next = scenes[endIndex + 1];
  const orientation = scene.visual.intent.orientation;
  const durationMs = scenes[endIndex].endMs - scene.startMs;
  const duration = (durationMs / playbackRate / 1000).toFixed(1);
  const localLoading = localResult?.request !== request;
  const localItems = localLoading ? [] : localResult?.result?.candidates ?? [];
  const selectedLocal = localItems.find(candidate => candidateKey(candidate) === localSelection) ?? localItems[0];
  const automaticSearch = localResult?.request.query === request.query ? localResult.result : undefined;
  const keyword = request.query || automaticSearch?.onlineQuery || automaticSearch?.query.split(/\s+/u).slice(0, 4).join(' ') || '';
  const onlineCurrent = onlineResult?.keyword === keyword && onlineResult.revision === onlineRevision;
  const onlineLoading = (localLoading && !request.query) || Boolean(keyword && !onlineCurrent);
  const onlineItems = onlineLoading || !onlineCurrent ? [] :
    [...(onlineResult.items ?? [])].sort((left, right) => onlinePriority(left, durationMs) - onlinePriority(right, durationMs));
  const selectedOnline = onlineItems.find(item => item.id === onlineSelection && onlinePriority(item, durationMs) < 2);
  const selectedName = source === 'local' ? selectedLocal?.asset.name : selectedOnline?.name;

  useEffect(() => {
    let active = true;
    void desktop.listSceneCandidates(projectId, scene.id, request.query, throughSceneId).then(result => {
      if (active) setLocalResult({ request, result });
    }).catch(error => {
      if (active) setLocalResult({ request, error: errorMessage(error) });
    });
    return () => { active = false; };
  }, [desktop, projectId, scene.id, request, throughSceneId]);

  useEffect(() => {
    if (!keyword) return;
    let active = true;
    async function searchOnline() {
      try {
        const status = await desktop.pexelsStatus();
        if (!active) return;
        if (!status.configured) {
          setOnlineResult({ keyword, revision: onlineRevision, needsKey: true });
          return;
        }
        const types = ['video', 'image'] as const;
        const results = await Promise.allSettled(types.map(type => desktop.searchPexels({
          query: keyword, type, page: 1, orientation
        })));
        if (!active) return;
        const items = results.flatMap(result => result.status === 'fulfilled' ? result.value.items : []);
        const error = !items.length ? results.find(result => result.status === 'rejected') : undefined;
        setOnlineResult({ keyword, revision: onlineRevision, items, error: error && errorMessage(error.reason) });
      } catch (error) {
        if (active) setOnlineResult({ keyword, revision: onlineRevision, error: errorMessage(error) });
      }
    }
    void searchOnline();
    return () => { active = false; };
  }, [desktop, keyword, onlineRevision, orientation]);

  function changeEnd(index: number) {
    if (pending) return;
    setApplyError('');
    setRequest({ ...request, endIndex: index });
  }

  function resetResultsScroll() {
    const body = bodyRef.current;
    const toolbar = toolbarRef.current;
    const results = resultsRef.current;
    if (body && toolbar && results) body.scrollTop = Math.min(body.scrollTop, results.offsetTop - toolbar.offsetHeight);
  }

  function switchSource(value: Source) {
    if (pending || value === source) return;
    resetResultsScroll();
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-source="${value}"]`)?.focus({ preventScroll: true });
    setApplyError('');
    setSource(value);
  }

  async function apply(choice: SceneChoice | OnlineAsset) {
    if (pending) return;
    const online = 'id' in choice;
    setPending(online ? 'download' : 'apply');
    setApplyError('');
    try {
      if (online) {
        const asset = await desktop.downloadPexels(choice.id);
        await onAssetsChanged();
        await onApply({ type: 'asset', assetId: asset.id, sourceInMs: asset.type === 'video' ? 0 : undefined, throughSceneId });
      } else {
        await onApply({ ...choice, throughSceneId });
      }
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally {
      setPending(undefined);
    }
  }

  return <Modal title="选择分镜画面" close={() => { if (!pending) onClose(); }} closeDisabled={!!pending} className="scene-picker">
    <div className="scene-picker-body" ref={bodyRef}>
      <section className="scene-picker-script" aria-labelledby={`${id}-script`}>
        <div className="scene-picker-script-heading">
          <h3 id={`${id}-script`}>当前台词</h3>
          <span>画面播放 {duration} 秒</span>
        </div>
        <p className="scene-picker-current">{scene.script}</p>
        {endIndex > 0 && <ol className="scene-picker-included" aria-label="共用这个画面的后续台词">
          {scenes.slice(1, endIndex + 1).map(item => <li key={item.id}><Check size={15} aria-hidden="true"/>{item.script}</li>)}
        </ol>}
        {(next || endIndex > 0) && <div className="scene-picker-range">
          {next && <button type="button" className="scene-picker-extend" disabled={!!pending} onClick={() => changeEnd(endIndex + 1)}>
            <Plus size={16} aria-hidden="true"/>
            <span><b>延长当前分镜画面到下一句</b><span>{next.script}</span></span>
          </button>}
          {endIndex > 0 && <button type="button" className="scene-picker-link scene-picker-undo" disabled={!!pending} onClick={() => changeEnd(endIndex - 1)}>
            <Undo2 size={15} aria-hidden="true"/> 撤回最后一句
          </button>}
        </div>}
      </section>

      <div className="scene-picker-toolbar" ref={toolbarRef}>
        <div role="tablist" aria-label="画面来源" className="scene-picker-tabs" ref={tabsRef} onKeyDown={event => {
          if (pending || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const value = event.key === 'Home' ? 'local' : event.key === 'End' ? 'online' : source === 'local' ? 'online' : 'local';
          switchSource(value);
        }}>
          {sources.map(({ id: value, label, icon: Icon }) => <button type="button" role="tab" key={value}
            id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={source === value}
            tabIndex={source === value ? 0 : -1} data-source={value} disabled={!!pending} onClick={() => switchSource(value)}>
            <Icon size={16} aria-hidden="true"/> {label}
          </button>)}
        </div>
        <form className="scene-picker-search" onSubmit={event => {
          event.preventDefault();
          if (pending) return;
          resetResultsScroll();
          setApplyError('');
          setLocalSelection(undefined);
          setOnlineSelection(undefined);
          setRequest({ ...request, query: query.trim(), revision: request.revision + 1 });
        }}>
          <input type="search" value={query} maxLength={150} aria-label="画面关键词" placeholder="搜索视频或图片"
            disabled={!!pending} onChange={event => setQuery(event.target.value)}/>
          <button type="submit" aria-label="搜索" title="搜索" disabled={!!pending}><Search size={17} aria-hidden="true"/></button>
        </form>
      </div>

      <div className="scene-picker-results" ref={resultsRef}>
        <section role="tabpanel" id={`${id}-local-panel`} aria-labelledby={`${id}-local-tab`} hidden={source !== 'local'}>
          {source === 'local' && (localLoading ? <p className="scene-picker-empty" role="status">正在查找本地素材…</p>
            : localResult?.error ? <p className="scene-picker-empty" role="alert">{localResult.error}</p>
            : selectedLocal ? <div className="scene-picker-local">
              <div className="scene-picker-grid">{localItems.map(candidate => {
                const video = candidate.asset.type === 'video';
                const start = candidate.choice.type === 'asset' ? candidate.choice.sourceInMs ?? 0 : 0;
                return <button type="button" className="scene-picker-card" key={candidateKey(candidate)} aria-pressed={selectedLocal === candidate}
                  disabled={!!pending} onClick={() => { setLocalSelection(candidateKey(candidate)); setApplyError(''); }}>
                  <div className="scene-picker-thumb">
                    {candidate.asset.thumbnailPath ? <img src={`voxweave-library://${candidate.asset.id}/thumbnail`} alt="" loading="lazy"/>
                      : video ? <Film size={26} aria-hidden="true"/> : <Image size={26} aria-hidden="true"/>}
                    <span>{video ? `视频 · ${(start / 1000).toFixed(1)} 秒起` : '图片'}</span>
                    {selectedLocal === candidate && <Check className="scene-picker-check" size={20} aria-hidden="true"/>}
                  </div>
                  <b title={candidate.asset.name}>{candidate.asset.name}</b>
                </button>;
              })}</div>
              <div className="scene-picker-preview">
                <h3>画面预览</h3>
                {selectedLocal.asset.type === 'video' ? <video key={candidateKey(selectedLocal)} src={`voxweave-library://${selectedLocal.asset.id}/media`}
                  aria-label={selectedLocal.asset.name} controls preload="metadata" onLoadedMetadata={event => {
                    event.currentTarget.playbackRate = playbackRate;
                    if (selectedLocal.choice.type === 'asset') event.currentTarget.currentTime = (selectedLocal.choice.sourceInMs ?? 0) / 1000;
                  }} onPlay={event => {
                    if (selectedLocal.sourceOutMs !== undefined && event.currentTarget.currentTime >= selectedLocal.sourceOutMs / 1000 &&
                        selectedLocal.choice.type === 'asset') event.currentTarget.currentTime = (selectedLocal.choice.sourceInMs ?? 0) / 1000;
                  }} onTimeUpdate={event => {
                    if (selectedLocal.sourceOutMs !== undefined && event.currentTarget.currentTime >= selectedLocal.sourceOutMs / 1000) event.currentTarget.pause();
                  }}/>
                  : <img src={`voxweave-library://${selectedLocal.asset.id}/media`} alt={selectedLocal.asset.name}/>}
              </div>
            </div> : <div className="scene-picker-empty">
              <p>本地素材库里没有适合这段台词的画面。</p>
              <button type="button" className="scene-picker-link" onClick={() => switchSource('online')}>去 Pexels 找素材</button>
            </div>)}
        </section>

        <section role="tabpanel" id={`${id}-online-panel`} aria-labelledby={`${id}-online-tab`} hidden={source !== 'online'}>
          {source === 'online' && <>
            {onlineLoading ? <p className="scene-picker-empty" role="status">正在搜索在线素材…</p>
              : !keyword ? <p className="scene-picker-empty">输入关键词，在 Pexels 搜索视频和图片。</p>
              : onlineResult?.needsKey ? <div className="scene-picker-empty">
                <p>连接 Pexels 后即可搜索在线素材。</p>
                <button type="button" className="scene-picker-link" disabled={!!pending} onClick={onOpenOnlineLibrary}>设置 Pexels 密钥</button>
              </div>
              : onlineResult?.error ? <p className="scene-picker-empty" role="alert">{onlineResult.error}</p>
              : onlineItems.length ? <>
                <div className="scene-picker-attribution">
                  <button type="button" className="scene-picker-link" onClick={() => void desktop.openSource('https://www.pexels.com/')}>
                    素材由 Pexels 提供 <ExternalLink size={12} aria-hidden="true"/>
                  </button>
                </div>
                <div className="scene-picker-grid scene-picker-online">{onlineItems.map(item => {
                  const tooShort = onlinePriority(item, durationMs) === 2;
                  return <article className="scene-picker-online-card" key={item.id}>
                    <button type="button" className="scene-picker-card" aria-pressed={selectedOnline === item}
                      disabled={tooShort || !!pending} onClick={() => { setOnlineSelection(item.id); setApplyError(''); }}>
                      <div className="scene-picker-thumb">
                        <img src={item.thumbnailUrl} alt="" loading="lazy"/>
                        <span>{item.type === 'video' ? `视频 · ${((item.durationMs ?? 0) / 1000).toFixed(1)} 秒` : '图片'}</span>
                        {selectedOnline === item && <Check className="scene-picker-check" size={20} aria-hidden="true"/>}
                      </div>
                      <b title={item.name}>{item.name}</b>
                      {tooShort && <small>视频太短，无法播完所选台词</small>}
                    </button>
                    <button type="button" className="scene-picker-link scene-picker-author" title={item.author}
                      onClick={() => void desktop.openSource(item.sourceUrl)}>{item.author}<ExternalLink size={12} aria-hidden="true"/></button>
                  </article>;
                })}</div>
              </> : <p className="scene-picker-empty">没有找到素材，试试其他关键词。</p>}
          </>}
        </section>
      </div>
    </div>

    <footer className="scene-picker-footer">
      {applyError && <p className="field-error" role="alert">{applyError}</p>}
      <div className="scene-picker-footer-row">
        <div className="scene-picker-summary">
          {selectedName && <b title={selectedName}>{selectedName}</b>}
          <span aria-live="polite">{endIndex ? `${endIndex + 1} 句共用一个画面` : '仅用于当前台词'} · {duration} 秒</span>
        </div>
        <div className="scene-picker-actions">
          <button type="button" className="scene-picker-secondary" disabled={!!pending || (scene.visual.type === 'kinetic-text' && endIndex === 0)}
            onClick={() => void apply({ type: 'kinetic-text' })}><Type size={15} aria-hidden="true"/> 仅用文字做画面</button>
          <button type="button" className="modal-primary" disabled={!!pending || !selectedName} onClick={() => {
            const choice = source === 'local' ? selectedLocal?.choice : selectedOnline;
            if (choice) void apply(choice);
          }}>{pending === 'download' ? '正在下载并应用…' : pending === 'apply' ? '正在更新预览…' : source === 'online' ? '下载并应用' : '应用画面'}</button>
        </div>
      </div>
    </footer>
  </Modal>;
}
