import { useState } from 'react';
import type { TalkFraming } from '../shared/talking-head';

export function TalkFramingPanel({ framing, disabled, apply }: { framing: TalkFraming; disabled: boolean; apply: (value: TalkFraming) => void }) {
  const [draft, setDraft] = useState(framing);
  const change = (value: Partial<TalkFraming>) => setDraft(previous => ({ ...previous, ...value }));
  const custom = draft.aspect !== 'source';
  return <details className="talk-framing">
    <summary>画幅与取景</summary>
    <label className="talk-field">成片画幅<select value={draft.aspect} disabled={disabled}
      onChange={event => change({ aspect: event.target.value as TalkFraming['aspect'] })}>
      <option value="source">原片画幅</option><option value="9:16">9:16 竖屏</option>
      <option value="16:9">16:9 横屏</option><option value="1:1">1:1 方形</option>
    </select></label>
    {custom && <label className="talk-field">取景方式<select value={draft.layout} disabled={disabled}
      onChange={event => change({ layout: event.target.value as TalkFraming['layout'] })}>
      <option value="fit">保留完整画面</option><option value="crop">填满画幅，手动取景</option>
    </select></label>}
    {custom && draft.layout === 'crop' && <>
      <label className="talk-field">水平位置<input type="range" min="0" max="100" value={draft.x} disabled={disabled}
        onChange={event => change({ x: Number(event.target.value) })}/></label>
      <label className="talk-field">垂直位置<input type="range" min="0" max="100" value={draft.y} disabled={disabled}
        onChange={event => change({ y: Number(event.target.value) })}/></label>
    </>}
    <button className="talk-primary" disabled={disabled || JSON.stringify(framing) === JSON.stringify(draft)} onClick={() => apply(draft)}>应用画幅与取景</button>
  </details>;
}
