import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan } from '../../shared/edit-plan.js';
import { captionStates } from '../../shared/caption-highlights.js';
import { assertResolvedPlan, type PreparedComposition } from './renderer.js';

const require = createRequire(import.meta.url);

export type AssetPathResolver = (assetId: string) => Promise<string> | string;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
}

function safeExtension(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : '.bin';
}

/** @hyperframes/core 0.8.38 advertises every finite timeline as at least one
 * second. That leaves sub-second compositions blank after their real end.
 * Keep its transport contract but use our 30-fps minimum of one frame. */
function patchRuntimeDuration(runtime: string): string {
  const floor = 'Math.max(1,k||1,A??0)';
  if (runtime.split(floor).length !== 2) throw new Error('渲染运行库已变化，请更新短视频时长适配');
  return runtime.replace(floor, 'Math.max(1/30,k||1/30,A??0)');
}

function cueMarkup(plan: EditPlan): string {
  const rate = plan.output.playbackRate;
  let captionIndex = 0;
  return plan.captions.flatMap(cue => {
    const chars = Array.from(cue.text);
    let cursor = 0;
    const ranges = cue.highlightUnits ?? cue.tokens.map(token => {
      const startChar = cursor; cursor += Array.from(token.text).length;
      return { startChar, endChar: cursor };
    });
    const boundaries = [...new Set([0, chars.length, ...ranges.flatMap(range => [range.startChar, range.endChar])])].sort((a, b) => a - b);
    return captionStates(cue, plan.template.captionHighlight).map(active => {
      const words = boundaries.slice(0, -1).map((start, index) => {
        const end = boundaries[index + 1];
        const selected = active.startChar !== undefined && start >= active.startChar && end <= active.endChar!;
        return `<span${selected ? ' class="active"' : ''}>${escapeHtml(chars.slice(start, end).join(''))}</span>`;
      }).join('');
      const id = `caption-${captionIndex++}`;
      return `<div id="${id}" class="caption ${escapeHtml(plan.template.captionStyle)}" data-animate-start="${seconds(active.startMs / rate)}" data-animate-duration="${seconds((active.endMs - active.startMs) / rate)}" aria-label="${escapeHtml(cue.text)}">${words}</div>`;
    });
  }).join('\n');
}

function kineticMarkup(script: string, startMs: number, durationMs: number, index: number): string {
  return `<div id="kinetic-${index}" class="kinetic" data-animate-start="${seconds(startMs)}" data-animate-duration="${seconds(durationMs)}"><div class="kinetic-grid"></div><p>${escapeHtml(script)}</p></div>`;
}

function compositionCss(plan: EditPlan): string {
  const portrait = plan.canvas.height > plan.canvas.width;
  return `
    @font-face{font-family:VoxSans;src:local("Microsoft YaHei UI"),local("Noto Sans CJK SC");font-display:swap}
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${escapeHtml(plan.canvas.background)}}
    body{font-family:VoxSans,"Segoe UI",sans-serif;color:#fff}#stage{position:relative;width:${plan.canvas.width}px;height:${plan.canvas.height}px;overflow:hidden;background:${escapeHtml(plan.canvas.background)}}
    #stage>.clip,#stage>[data-composition-id]{position:absolute;inset:0}.visual{width:100%;height:100%;object-fit:cover}.visual.contain{object-fit:contain}
    .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,8,11,.04) 45%,rgba(5,8,11,.78) 100%);pointer-events:none}
    .kinetic,.caption{position:absolute;inset:0;visibility:hidden;opacity:0}.kinetic{display:grid;place-items:center;padding:${portrait ? 110 : 76}px;background:radial-gradient(circle at 72% 25%,rgba(217,255,105,.18),transparent 27%),linear-gradient(145deg,#16191f,#08090c)}
    .kinetic-grid{position:absolute;inset:0;opacity:.18;background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px);background-size:64px 64px}
    .kinetic p{position:relative;width:min(82%,1200px);margin:0;text-align:center;font-size:${portrait ? 92 : 76}px;line-height:1.28;font-weight:850;letter-spacing:-.03em;text-wrap:balance;text-shadow:0 8px 36px rgba(0,0,0,.42)}
    .caption{display:flex;align-items:flex-end;justify-content:center;gap:.12em;padding:0 ${portrait ? 72 : 110}px ${portrait ? 190 : 92}px;font-size:${portrait ? 66 : 52}px;line-height:1.35;font-weight:800;text-align:center;text-shadow:0 3px 5px #000,0 0 18px #000;white-space:pre-wrap}
    .caption span{display:inline-block}.caption span.active{color:#d9ff69;transform:scale(1.09)}
    .caption.brand-minimal{align-items:center;padding-bottom:0;font-weight:650}.caption.info-card{justify-content:flex-start;text-align:left}.caption.commerce-bold span.active{color:#ffe26d}
    @media(prefers-reduced-motion:reduce){.caption span.active{transform:none}}
  `;
}

export async function compileFixedTemplate(
  plan: EditPlan,
  workspace: string,
  resolveAsset: AssetPathResolver = assetId => {
    if (assetId === 'source-video' && plan.input.sourceVideoPath) return plan.input.sourceVideoPath;
    throw new Error(`无法解析素材 ${assetId}`);
  }
): Promise<PreparedComposition> {
  assertResolvedPlan(plan);
  const rate = plan.output.playbackRate;
  const assetsDir = path.join(workspace, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const runtimeSource = require.resolve('@hyperframes/core/runtime');
  const gsapSource = require.resolve('gsap/dist/gsap.min.js');
  await Promise.all([
    readFile(runtimeSource, 'utf8').then(runtime => writeFile(path.join(workspace, 'hyperframe.runtime.iife.js'), patchRuntimeDuration(runtime))),
    copyFile(gsapSource, path.join(workspace, 'gsap.min.js')),
    copyFile(plan.narration.audioPath, path.join(assetsDir, `narration${safeExtension(plan.narration.audioPath)}`))
  ]);

  const copied = new Map<string, string>();
  const visuals: string[] = [];
  const kinetics: string[] = [];
  for (let index = 0; index < plan.scenes.length; index++) {
    const scene = plan.scenes[index];
    const duration = scene.endMs - scene.startMs;
    if (scene.visual.type === 'kinetic-text') {
      kinetics.push(kineticMarkup(scene.script, scene.startMs / rate, duration / rate, index));
      continue;
    }
    let last = index;
    while (last + 1 < plan.scenes.length) {
      const previous = plan.scenes[last];
      const next = plan.scenes[last + 1];
      if (next.startMs !== previous.endMs || next.visual.type !== scene.visual.type ||
        next.visual.assetId !== scene.visual.assetId || next.visual.fit !== scene.visual.fit ||
        next.visual.motion !== scene.visual.motion) break;
      if (scene.visual.type !== 'image' && (next.visual.sourceInMs ?? 0) !==
        (previous.visual.sourceOutMs ?? (previous.visual.sourceInMs ?? 0) + previous.endMs - previous.startMs)) break;
      last++;
    }
    const assetId = scene.visual.assetId;
    if (!assetId) throw new Error(`分镜 ${scene.id} 缺少素材 ID`);
    let relative = copied.get(assetId);
    if (!relative) {
      const source = await resolveAsset(assetId);
      relative = `assets/visual-${copied.size + 1}${safeExtension(source)}`;
      await copyFile(source, path.join(workspace, relative));
      copied.set(assetId, relative);
    }
    const tag = scene.visual.type === 'image' ? 'img' : 'video';
    const mediaStart = scene.visual.sourceInMs ? ` data-media-start="${seconds(scene.visual.sourceInMs)}"` : '';
    const mediaAttributes = tag === 'video' ? ` muted playsinline data-playback-rate="${rate}"` : '';
    visuals.push(`<${tag} id="visual-${index}" class="clip visual ${scene.visual.fit}" src="./${escapeHtml(relative)}" preload="auto" data-start="${seconds(scene.startMs / rate)}" data-duration="${seconds((plan.scenes[last].endMs - scene.startMs) / rate)}"${mediaStart} data-track-index="1"${mediaAttributes}></${tag}>`);
    index = last;
  }

  const durationSeconds = seconds(plan.narration.durationMs / rate);
  const narrationName = `narration${safeExtension(plan.narration.audioPath)}`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; media-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:">
<style>${compositionCss(plan)}</style><script src="./gsap.min.js"></script><script>window.__timelines=window.__timelines||{};</script></head>
<body><main id="stage" data-composition-id="voxweave-root" data-start="0" data-duration="${durationSeconds}" data-width="${plan.canvas.width}" data-height="${plan.canvas.height}">
${visuals.join('\n')}
<div id="kinetic-layer" data-composition-id="voxweave-kinetics" data-start="0" data-track-index="2">${kinetics.join('\n')}</div>
<div class="shade"></div>
<div id="caption-layer" data-composition-id="voxweave-captions" data-start="0" data-track-index="3" data-timeline-role="captions">${cueMarkup(plan)}</div>
<audio id="narration" class="clip" src="./assets/${narrationName}" preload="auto" data-start="0" data-duration="${durationSeconds}" data-track-index="4"></audio>
</main><script>
function timedLayer(selector,duration){const tl=gsap.timeline({paused:true});for(const el of document.querySelectorAll(selector)){const start=Number(el.dataset.animateStart);const length=Number(el.dataset.animateDuration);tl.set(el,{autoAlpha:0},0);tl.fromTo(el,{autoAlpha:1},{autoAlpha:1,duration:length,immediateRender:false,ease:"none"},start);tl.set(el,{autoAlpha:0},start+length)}tl.set({}, {}, duration);return tl}
window.__timelines["voxweave-kinetics"]=timedLayer("#kinetic-layer>[data-animate-start]",${durationSeconds});
window.__timelines["voxweave-captions"]=timedLayer("#caption-layer>[data-animate-start]",${durationSeconds});
const tl=gsap.timeline({paused:true});tl.set({}, {}, ${durationSeconds});window.__timelines["voxweave-root"]=tl;</script>
<script src="./hyperframe.runtime.iife.js"></script></body></html>`;
  const entryPath = path.join(workspace, 'index.html');
  await writeFile(entryPath, html, 'utf8');
  await writeFile(path.join(workspace, 'composition.json'), `${JSON.stringify({
    planId: plan.id, revision: plan.revision, template: plan.template, durationMs: Math.round(plan.narration.durationMs / rate)
  }, null, 2)}\n`, 'utf8');
  return { entryUrl: entryPath, workspace, durationMs: Math.round(plan.narration.durationMs / rate) };
}

export { escapeHtml };
