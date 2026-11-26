import { useCallback, useEffect, useRef, useState } from 'react';
import { Library, Settings2 } from 'lucide-react';
import { App, type WorkspaceDialog } from './App';
import { TalkingHead } from './TalkingHead';
import type { MediaAsset } from '../shared/library';
import appIcon from '../build/icon.svg';
import './talking-head.css';

export function Workspace() {
  const [mode, setMode] = useState<'script' | 'talking-head'>(() => {
    try { return localStorage.getItem('voxweave-workflow') === 'talking-head' ? 'talking-head' : 'script'; }
    catch { return 'script'; }
  });
  const [visitedTalk, setVisitedTalk] = useState(mode === 'talking-head');
  const [dialog, setDialog] = useState<WorkspaceDialog>();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const refreshAssets = useCallback(async () => {
    const items = await window.voxweave?.listAssets();
    if (items) setAssets(items);
  }, []);
  useEffect(() => { void refreshAssets().catch(() => undefined); }, [refreshAssets]);
  const scriptPane = useRef<HTMLDivElement>(null), talkPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { localStorage.setItem('voxweave-workflow', mode); } catch { /* Storage may be disabled. */ }
    if (mode === 'talking-head') setVisitedTalk(true);
    const hidden = mode === 'script' ? talkPane.current : scriptPane.current;
    hidden?.querySelectorAll('video,audio,hyperframes-player').forEach(element => {
      (element as HTMLElement & { pause?: () => void }).pause?.();
    });
  }, [mode]);
  return <div className="workspace-shell">
    <header className="workspace-header drag-region">
      <div className="workspace-brand"><img src={appIcon} alt=""/><strong>帧舟</strong><span>FrameSkiff</span></div>
      <nav className="workflow-nav no-drag" aria-label="创作模式">
        <button aria-pressed={mode === 'script'} onClick={() => setMode('script')}>文案成片</button>
        <button aria-pressed={mode === 'talking-head'} onClick={() => setMode('talking-head')}>口播精剪</button>
      </nav>
      <div className="workspace-actions no-drag">
        <button className="library-button" aria-label="素材库" onClick={() => setDialog('library')}><Library size={16}/><span>素材库</span></button>
        <button className="icon-button" aria-label="打开创作设置" title="创作设置" onClick={() => setDialog('settings')}><Settings2 size={17}/></button>
      </div>
    </header>
    <div ref={scriptPane} className="workflow-pane" hidden={mode !== 'script'}>
      <App active={mode === 'script'} dialog={dialog} openDialog={setDialog} assets={assets} refreshAssets={refreshAssets}/>
    </div>
    <div ref={talkPane} className="workflow-pane" hidden={mode !== 'talking-head'}>
      {visitedTalk && <TalkingHead active={mode === 'talking-head'} assets={assets} dialogOpen={Boolean(dialog)} openLibrary={() => setDialog('library')}/>}
    </div>
  </div>;
}
