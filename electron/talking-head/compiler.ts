import { createRequire } from 'node:module';
import { mkdir, copyFile, link, access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { talkTimeline, talkDuration, type TalkProject, type TalkOverlay } from '../../shared/talking-head.js';
import { talkCaptionStates, talkOutputCaptions } from './captions.js';
import { escapeHtml } from '../renderers/template-compiler.js';
import type { PreparedComposition } from '../renderers/renderer.js';

const require = createRequire(import.meta.url);
const sec = (time: number) => (time / 1000).toFixed(3);
export interface TalkAsset { filePath: string; type: 'image' | 'video' | 'audio'; durationMs?: number }
export type TalkAssetResolver = (id: string) => TalkAsset;

async function materialize(source: string, target: string): Promise<void> {
  try { await access(target); return; } catch { /* New workspace. */ }
  // All source files are immutable derived assets, never user input files.
  try { await link(source, target); } catch { await copyFile(source, target); }
}

function graphic(overlay: TalkOverlay, startMs: number, endMs: number, id: string): string {
  const whiteboard = overlay.type === 'whiteboard';
  return `<div id="${id}" class="graphic ${whiteboard ? 'whiteboard' : 'callout'} ${overlay.layout} ${overlay.position}" data-animate-start="${sec(startMs)}" data-animate-duration="${sec(endMs - startMs)}">${whiteboard ? '<svg class="sketch" viewBox="0 0 500 280" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M14 14 Q250 3 486 14 L480 266 Q260 277 14 264 Z"/><path pathLength="1" d="M58 224 Q250 214 438 225"/></svg>' : ''}<p>${escapeHtml(overlay.text)}</p></div>`;
}

export async function compileTalkTemplate(project: TalkProject, directory: string, workspace: string,
  audioPath: string, resolveAsset: TalkAssetResolver): Promise<PreparedComposition> {
  const spans = talkTimeline(project), durationMs = talkDuration(project);
  if (durationMs < 34) throw new Error('口播成片至少需要保留一帧画面');
  const assets = path.join(workspace, 'assets'); await mkdir(assets, { recursive: true });
  let runtime = await readFile(require.resolve('@hyperframes/core/runtime'), 'utf8');
  const floor = 'Math.max(1,k||1,A??0)';
  if (runtime.split(floor).length !== 2) throw new Error('渲染运行库已变化，请更新口播时长适配');
  runtime = runtime.replace(floor, 'Math.max(1/30,k||1/30,A??0)');
  await Promise.all([
    writeFile(path.join(workspace, 'hyperframe.runtime.iife.js'), runtime),
    copyFile(require.resolve('gsap/dist/gsap.min.js'), path.join(workspace, 'gsap.min.js')),
    materialize(path.join(directory, 'media', 'source.mp4'), path.join(assets, 'source.mp4')),
    materialize(audioPath, path.join(assets, 'voice.wav'))
  ]);
  const base = spans.map((span, index) => `<video id="source-${index}" class="clip base" src="./assets/source.mp4" muted playsinline preload="auto" data-start="${sec(span.outputStartMs)}" data-duration="${sec(span.outputEndMs - span.outputStartMs)}" data-media-start="${sec(span.startMs)}" data-track-index="1"></video>`).join('\n');
  const overlays: string[] = [], copied = new Map<string, string>();
  let overlayIndex = 0;
  for (const overlay of project.overlays.filter(overlay => overlay.enabled)) {
    const cue = project.cues.find(cue => cue.id === overlay.cueId)!;
    let asset: TalkAsset | undefined, relative: string | undefined;
    if (overlay.assetId) {
      asset = resolveAsset(overlay.assetId);
      if (asset.type !== overlay.type) throw new Error('增强素材类型不匹配');
      relative = copied.get(overlay.assetId);
      if (!relative) {
        const extension = path.extname(asset.filePath).toLowerCase();
        if (!/^\.[a-z0-9]{1,8}$/u.test(extension)) throw new Error('增强素材扩展名无效');
        relative = `overlay-${copied.size + 1}${extension}`;
        // Imported library originals may be changed externally: snapshot them for this revision.
        await copyFile(asset.filePath, path.join(assets, relative)); copied.set(overlay.assetId, relative);
      }
    }
    for (const span of spans) {
      const startMs = Math.max(span.startMs, cue.startMs), endMs = Math.min(span.endMs, cue.endMs);
      if (endMs <= startMs) continue;
      const shift = span.outputStartMs - span.startMs;
      const id = `overlay-${overlayIndex++}`;
      if (!asset) overlays.push(graphic(overlay, startMs + shift, endMs + shift, id));
      else {
        const mediaStart = overlay.sourceInMs + startMs - cue.startMs;
        const length = asset.type === 'video' ? Math.min(endMs - startMs, (asset.durationMs ?? 0) - mediaStart) : endMs - startMs;
        if (length <= 0) continue;
        const tag = asset.type === 'video' ? 'video' : 'img';
        overlays.push(`<${tag} id="${id}" class="clip media-overlay ${overlay.layout} ${overlay.position}" src="./assets/${escapeHtml(relative!)}" data-start="${sec(startMs + shift)}" data-duration="${sec(length)}" data-track-index="2"${tag === 'video' ? ` muted playsinline data-media-start="${sec(mediaStart)}"` : ''}></${tag}>`);
      }
    }
  }
  const captionEntries = project.captions.enabled ? talkOutputCaptions(project).flatMap(cue => talkCaptionStates(cue, project.captions).map((state, index) => {
    const chars = Array.from(cue.text), boundaries = [...new Set([0, chars.length, state.visibleEnd,
      state.activeStart ?? 0, state.activeEnd ?? 0])].sort((a, b) => a - b);
    const text = boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1], visible = start < state.visibleEnd;
      const active = visible && state.activeStart !== undefined && start >= state.activeStart && end <= state.activeEnd!;
      return `<span class="${visible ? active ? 'active' : '' : 'unrevealed'}">${escapeHtml(chars.slice(start, end).join(''))}</span>`;
    }).join('');
    return `<div class="caption ${project.captions.position} effect-${project.captions.highlight}" id="caption-${escapeHtml(cue.id)}-${index}" data-animate-start="${sec(state.startMs)}" data-animate-duration="${sec(state.endMs - state.startMs)}"><p>${text}</p></div>`;
  })).join('\n') : '';
  const { width, height } = project.source;
  const size = Math.round(width * (height > width ? .055 : .036));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; media-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#08090b}body{font-family:"Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#fff}#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden}
.base{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}#overlay-layer,#caption-layer{position:absolute;inset:0;pointer-events:none}#overlay-layer{z-index:2}#caption-layer{z-index:3}.caption,.graphic{visibility:hidden;opacity:0}
.caption{position:absolute;inset:0;display:flex;justify-content:center;align-items:flex-end;padding:0 7% 10%;font-size:${size}px;line-height:1.4;font-weight:800;text-align:center;text-shadow:0 2px 6px #000,0 0 12px #000}.caption.top{align-items:flex-start;padding:10% 7% 0}.caption p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.caption span{display:inline}.caption .unrevealed{visibility:hidden}.caption .active{color:#d9ff69}.effect-box .active{background:#253b2be6;border-radius:.15em;box-shadow:0 0 0 .08em #253b2be6}.effect-scale .active{display:inline-block;transform:scale(1.08)}
.media-overlay,.graphic{position:absolute}.media-overlay{object-fit:contain;background:#101113}.cover{inset:0;width:100%;height:100%}.pip{top:15%;width:40%;height:30%;border-radius:${Math.round(width * .015)}px;overflow:hidden;box-shadow:0 8px 32px #0005}.top-right.pip{right:5%}.top-left.pip{left:5%}.graphic{display:grid;place-items:center;padding:5%;text-align:center}.graphic p{position:relative;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:${Math.round(width * .037)}px;line-height:1.5;font-weight:750}.graphic.cover p{max-width:78%;font-size:${Math.round(width * .055)}px}.callout{background:#141c20ed;color:#d9ff69;border:2px solid #d9ff6960}.whiteboard{background:#fff9ed;color:#26302a}.sketch{position:absolute;inset:5%;width:90%;height:90%;fill:none;stroke:#345c42;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.whiteboard p{padding-bottom:8%}
</style><script src="./gsap.min.js"></script><script>window.__timelines={};</script></head><body>
<main id="stage" data-composition-id="talk-root" data-start="0" data-duration="${sec(durationMs)}" data-width="${width}" data-height="${height}">
${base}
<div id="overlay-layer" data-composition-id="talk-overlays" data-start="0" data-track-index="2">${overlays.join('\n')}</div>
<div id="caption-layer" data-composition-id="talk-captions" data-start="0" data-track-index="3" data-timeline-role="captions">${captionEntries}</div>
<audio id="voice" class="clip" src="./assets/voice.wav" preload="auto" data-start="0" data-duration="${sec(durationMs)}" data-track-index="4"></audio>
</main><script>
function timedLayer(selector){const tl=gsap.timeline({paused:true});for(const el of document.querySelectorAll(selector)){const start=Number(el.dataset.animateStart),length=Number(el.dataset.animateDuration);tl.set(el,{autoAlpha:0},0);tl.fromTo(el,{autoAlpha:1},{autoAlpha:1,duration:length,immediateRender:false,ease:"none"},start);tl.set(el,{autoAlpha:0},start+length);for(const p of el.querySelectorAll(".sketch path")){tl.fromTo(p,{strokeDasharray:1,strokeDashoffset:1},{strokeDashoffset:0,duration:Math.min(.7,length),ease:"none",immediateRender:false},start)}}tl.set({}, {}, ${sec(durationMs)});return tl}
window.__timelines["talk-overlays"]=timedLayer(".graphic[data-animate-start]");window.__timelines["talk-captions"]=timedLayer(".caption[data-animate-start]");const tl=gsap.timeline({paused:true});tl.set({}, {}, ${sec(durationMs)});window.__timelines["talk-root"]=tl;
</script><script src="./hyperframe.runtime.iife.js"></script></body></html>`;
  const entryUrl = path.join(workspace, 'index.html');
  await writeFile(entryUrl, html);
  return { entryUrl, workspace, durationMs };
}
