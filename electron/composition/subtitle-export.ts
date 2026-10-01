import type { EditPlan } from '../../shared/edit-plan.js';

function timestamp(milliseconds: number, ass = false): string {
  const units = Math.max(0, Math.round(milliseconds / (ass ? 10 : 1)));
  const base = ass ? 100 : 1000;
  const seconds = Math.floor(units / base);
  return `${ass ? Math.floor(seconds / 3600) : String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}${ass ? '.' : ','}${String(units % base).padStart(ass ? 2 : 3, '0')}`;
}

export function exportSrt(plan: EditPlan): string {
  const rate = plan.output.playbackRate;
  return plan.captions.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs / rate)} --> ${timestamp(Math.max(cue.startMs / rate + 1, cue.endMs / rate))}\n${cue.text.replace(/\r/g, '').trim()}\n`).join('\n');
}

function assText(text: string): string {
  return text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N');
}

export function exportAss(plan: EditPlan): string {
  const rate = plan.output.playbackRate;
  const portrait = plan.canvas.height > plan.canvas.width;
  const style = plan.template.captionStyle;
  const alignment = style === 'brand-minimal' ? 5 : style === 'info-card' ? 1 : 2;
  const accent = style === 'commerce-bold' ? '&H006DE2FF&' : '&H0069FFD9&';
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${plan.canvas.width}\nPlayResY: ${plan.canvas.height}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,${portrait ? 66 : 52},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,${alignment},${portrait ? 72 : 110},${portrait ? 72 : 110},${portrait ? 190 : 92},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = plan.captions.flatMap(cue => cue.tokens.map((active, activeIndex) => {
    const text = cue.tokens.map((token, index) => index === activeIndex
      ? `{\\c${accent}\\fscx109\\fscy109}${assText(token.text)}{\\r}` : assText(token.text)).join('');
    const start = active.startMs / rate;
    return `Dialogue: 0,${timestamp(start, true)},${timestamp(Math.max(start + 10, active.endMs / rate), true)},Default,,0,0,0,,${text}`;
  }));
  return header + lines.join('\n') + '\n';
}
