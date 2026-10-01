import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDraftEditPlan } from '../../shared/edit-plan.js';
import { resolveEditPlan } from '../composition/resolver.js';
import { compileFixedTemplate, escapeHtml } from './template-compiler.js';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map(item => rm(item, { recursive: true, force: true }))));

function wav(): Buffer {
  const output = Buffer.alloc(44 + 48_000);
  output.write('RIFF'); output.writeUInt32LE(output.length - 8, 4); output.write('WAVE', 8);
  output.write('fmt ', 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(24_000, 24); output.writeUInt32LE(48_000, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(48_000, 40); return output;
}

describe('fixed composition compiler', () => {
  it('escapes all user text and emits local-only runtime assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-template-')); temporary.push(root);
    const narrationPath = path.join(root, 'narration.wav'); await writeFile(narrationPath, wav());
    const draft = createDraftEditPlan({ id: 'template', script: '<img src=x onerror=alert(1)>。', voiceId: 'vivian' });
    const plan = resolveEditPlan(draft, { narration: {
      audioPath: narrationPath, durationMs: 1000,
      segments: [{ id: 'scene-001', text: draft.scenes[0].script, startMs: 0, endMs: 1000, audioPath: narrationPath }]
    }});
    const prepared = await compileFixedTemplate(plan, path.join(root, 'preview'));
    const html = await readFile(prepared.entryUrl, 'utf8');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
    expect(html).not.toMatch(/https?:\/\//u);
    expect(html).toContain("default-src 'self'");
    expect(html).not.toContain('#stage>[data-start]{position:absolute;inset:0;opacity:0}');
    expect(html).toContain('data-composition-id="voxweave-kinetics"');
    expect(html).toContain('data-composition-id="voxweave-captions"');
    expect(html).toContain('data-timeline-role="captions"');
    expect(html).toContain('timedLayer("#kinetic-layer>[data-animate-start]"');
    expect(html).toContain('tl.fromTo(el,{autoAlpha:1}');
    expect(html).toContain('class="clip" src="./assets/narration.wav"');
  });

  it('keeps source offsets while scaling visuals, captions and composition duration at 2x', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-speed-')); temporary.push(root);
    const audioPath = path.join(root, 'voice.wav'); await writeFile(audioPath, wav());
    const videoPath = path.join(root, 'source.mp4'); await writeFile(videoPath, 'video');
    const draft = createDraftEditPlan({ id: 'speed', script: '测试倍速。', voiceId: 'vivian', sourceVideoPath: videoPath });
    const plan = resolveEditPlan(draft, { sourceMetadata: { durationMs: 5000, hasAudio: true }, narration: {
      audioPath, durationMs: 4000, segments: [{ id: 'scene-001', text: '测试倍速。', startMs: 0, endMs: 4000, audioPath }]
    }});
    plan.output.playbackRate = 2;
    plan.scenes[0].visual.sourceInMs = 1000; plan.scenes[0].visual.sourceOutMs = 5000;
    const prepared = await compileFixedTemplate(plan, path.join(root, 'preview'));
    const html = await readFile(prepared.entryUrl, 'utf8');
    expect(prepared.durationMs).toBe(2000);
    expect(html).toContain('data-playback-rate="2"');
    expect(html).toContain('data-duration="2"');
    expect(html).toContain('data-media-start="1"');
    expect(html).toContain('data-animate-duration="1"');
    expect(html).toContain('data-animate-start="1"');
  });

  it('escapes HTML-significant characters' , () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe('&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
  });

  it('renders adjacent narration sentences on one continuous video clip', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'voxweave-shared-shot-')); temporary.push(root);
    const narrationPath = path.join(root, 'narration.wav'); await writeFile(narrationPath, wav());
    const videoPath = path.join(root, 'city.mp4'); await writeFile(videoPath, 'video fixture');
    const draft = createDraftEditPlan({ id: 'shared-shot', script: '你好。城市夜景。', voiceId: 'vivian' });
    const resolved = resolveEditPlan(draft, { narration: { audioPath: narrationPath, durationMs: 4000,
      segments: [
        { id: 'scene-001', text: '你好。', startMs: 0, endMs: 2000, audioPath: narrationPath },
        { id: 'scene-002', text: '城市夜景。', startMs: 2000, endMs: 4000, audioPath: narrationPath }
      ] } });
    const plan = { ...resolved, scenes: resolved.scenes.map((scene, index) => ({ ...scene, visual: {
      ...scene.visual, type: 'video' as const, assetId: 'city', sourceInMs: index * 2000,
      sourceOutMs: (index + 1) * 2000, motion: 'none' as const
    } })) };
    const prepared = await compileFixedTemplate(plan, path.join(root, 'preview'), () => videoPath);
    const html = await readFile(prepared.entryUrl, 'utf8');
    expect(html.match(/<video /gu)).toHaveLength(1);
    expect(html).toContain('data-duration="4"');
    expect(html).toContain('data-composition-id="voxweave-captions"');
  });
});
