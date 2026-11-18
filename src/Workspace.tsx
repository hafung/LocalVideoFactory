import { useEffect, useRef, useState } from 'react';
import { App } from './App';
import { TalkingHead } from './TalkingHead';
import './talking-head.css';

export function Workspace() {
  const [mode, setMode] = useState<'script' | 'talking-head'>(() => {
    try { return localStorage.getItem('voxweave-workflow') === 'talking-head' ? 'talking-head' : 'script'; }
    catch { return 'script'; }
  });
  const [visitedTalk, setVisitedTalk] = useState(mode === 'talking-head');
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
    <nav className="workflow-nav drag-region" aria-label="创作模式">
      <span>创作模式</span><div className="no-drag" role="group" aria-label="选择创作模式">
        <button aria-pressed={mode === 'script'} onClick={() => setMode('script')}>文案成片</button>
        <button aria-pressed={mode === 'talking-head'} onClick={() => setMode('talking-head')}>口播精剪</button>
      </div>
    </nav>
    <div ref={scriptPane} className="workflow-pane" hidden={mode !== 'script'}><App /></div>
    <div ref={talkPane} className="workflow-pane" hidden={mode !== 'talking-head'}>{visitedTalk && <TalkingHead active={mode === 'talking-head'} />}</div>
  </div>;
}
