import { useEffect, useRef, useState, type RefObject } from 'react';
import type { HyperframesPlayer } from '@hyperframes/player';
import { sourceToTalkTime, type TalkProject, type TalkVoiceAuditionRequest } from '../shared/talking-head';
import type { VoiceEnhancement } from '../shared/voice-enhancement';

const presets: Record<VoiceEnhancement, { label: string; hint: string }> = {
  off: { label: '关闭', hint: '' },
  natural: { label: '自然', hint: '轻柔处理低频杂音和齿音。' },
  clear: { label: '清晰', hint: '减轻闷感，让咬字更清楚。' },
  warm: { label: '温暖', hint: '增加厚度，让高频更柔和。' }
};

interface Props {
  project: TalkProject;
  canAudition: boolean;
  disabled: boolean;
  playerRef: RefObject<HyperframesPlayer | null>;
  apply: (preset: VoiceEnhancement) => void;
}

export function TalkVoiceEnhancement({ project, canAudition, disabled, playerRef, apply }: Props) {
  const applied = project.audio.voiceEnhancement;
  const [selection, setSelection] = useState<VoiceEnhancement>();
  const preset = selection ?? applied;

  return <>
    <label className="talk-field">人声增强
      <select aria-label="人声增强" disabled={disabled} value={preset}
        onChange={event => setSelection(event.target.value as VoiceEnhancement)}>
        {Object.entries(presets).map(([value, { label }]) => <option key={value} value={value}>{label}</option>)}
      </select>
      {presets[preset].hint && <small>{presets[preset].hint}</small>}
    </label>
    {preset !== applied && <div className="talk-actions">
      <button type="button" disabled={disabled} onClick={() => apply(preset)}>
        {preset === 'off' ? '关闭增强' : '应用增强'}
      </button>
      <span className="talk-hint">{applied === 'off' ? '当前使用原声' : `当前使用「${presets[applied].label}」`}</span>
    </div>}
    {canAudition && !disabled && preset !== 'off' && <VoiceComparison key={`${project.revision}:${preset}`}
      project={project} preset={preset} playerRef={playerRef}/>}
  </>;
}

function VoiceComparison({ project, preset, playerRef }: Pick<Props, 'project' | 'playerRef'> & {
  preset: TalkVoiceAuditionRequest['preset'];
}) {
  const [clips, setClips] = useState<{ original: string; enhanced: string }>();
  const [playing, setPlaying] = useState<'original' | 'enhanced'>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const request = useRef(0);

  useEffect(() => {
    const player = playerRef.current, audio = audioRef.current;
    const details = audio?.closest('details');
    const stop = () => audio?.pause();
    const stopWhenClosed = () => { if (!details?.open) stop(); };
    player?.addEventListener('play', stop);
    details?.addEventListener('toggle', stopWhenClosed);
    return () => {
      request.current++;
      player?.removeEventListener('play', stop);
      details?.removeEventListener('toggle', stopWhenClosed);
      stop();
    };
  }, [playerRef]);
  useEffect(() => () => {
    if (clips) {
      URL.revokeObjectURL(clips.original);
      URL.revokeObjectURL(clips.enhanced);
    }
  }, [clips]);

  async function prepare() {
    const api = window.voxweave?.talkingHead;
    if (!api) return;
    const id = ++request.current;
    audioRef.current?.pause();
    setClips(undefined); setError(''); setLoading(true);
    const playhead = Math.round((playerRef.current?.currentTime ?? 0) * 1000);
    const atMs = Number.isFinite(playhead) && playhead > 0 ? playhead
      : Math.max(0, sourceToTalkTime(project, project.cues[0]?.startMs ?? 0) - 250);
    try {
      const samples = await api.auditionVoice(project.id, { revision: project.revision, preset, atMs });
      if (request.current === id) {
        const url = (bytes: ArrayBuffer) => URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
        setClips({ original: url(samples.original), enhanced: url(samples.enhanced) });
      }
    } catch (error) {
      if (request.current === id) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === id) setLoading(false);
    }
  }

  async function play(kind: 'original' | 'enhanced') {
    const audio = audioRef.current;
    if (!audio || !clips) return;
    if (kind === playing && !audio.paused) { audio.pause(); return; }
    playerRef.current?.pause();
    setError(''); setPlaying(kind);
    audio.src = clips[kind];
    try { await audio.play(); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setPlaying(undefined); setError('无法播放试听片段，请重新取样。');
    }
  }

  return <>
    <div className="talk-actions">
      <button type="button" disabled={loading} onClick={() => void prepare()}>{loading ? '正在准备试听…' : clips ? '重新取样' : '试听对比'}</button>
      {clips && <>
        <button type="button" aria-pressed={playing === 'original'} onClick={() => void play('original')}>试听原声</button>
        <button type="button" aria-pressed={playing === 'enhanced'} onClick={() => void play('enhanced')}>试听增强</button>
      </>}
    </div>
    {clips && <p className="talk-hint">两版使用同一片段与响度目标。可移动成片播放位置后重新取样。</p>}
    {error && <p className="talk-error" role="alert">{error}</p>}
    <audio ref={audioRef} preload="none" onPause={event => { if (event.currentTarget.paused) setPlaying(undefined); }}
      onEnded={() => setPlaying(undefined)}/>
  </>;
}
