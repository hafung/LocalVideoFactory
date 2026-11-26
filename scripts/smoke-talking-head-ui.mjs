// Browser UI with real edit/compile/audio functions behind a desktop bridge fixture.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { updateTalkProject } from '../dist-electron/electron/talking-head/editing.js';
import { prepareTalkAudio, prepareTalkVoiceAudition } from '../dist-electron/electron/talking-head/media.js';
import { compileTalkTemplate } from '../dist-electron/electron/talking-head/compiler.js';
import { TalkProjectSchema, talkCanvas } from '../dist-electron/shared/talking-head.js';
import { editTalkHighlight } from '../dist-electron/electron/talking-head/highlights.js';

const base = process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178';
const root = path.resolve('.windows-smoke/talking-head');
const directory = path.join(root, 'project');
let project = TalkProjectSchema.parse(JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8')));
const tools = { ffmpegPath: process.env.VOXWEAVE_FFMPEG, ffprobePath: process.env.VOXWEAVE_FFPROBE,
  senseVoiceRoot: path.resolve('resources/models/sensevoice-small') };
const calls = [];
async function prepare() {
  const relative = `.windows-smoke/talking-head/ui-r${project.revision}`;
  const workspace = path.resolve(relative);
  const audio = await prepareTalkAudio(project, directory, tools, () => { throw new Error('No BGM'); });
  const prepared = await compileTalkTemplate(project, directory, workspace, audio, () => { throw new Error('No assets'); });
  return { project, preview: { entryUrl: `${base}/${relative}/index.html`, sourceUrl: `${base}/${relative}/assets/source.mp4`,
    durationMs: prepared.durationMs, ...talkCanvas(project) } };
}
const initial = await prepare();
const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1500, height: 1050 });
  await page.exposeFunction('__talkUpdate', async (id, change) => {
    assert.equal(id, project.id); calls.push(change);
    project = updateTalkProject(project, change); return prepare();
  });
  await page.exposeFunction('__talkAudition', async (id, request) => {
    assert.equal(id, project.id);
    assert.equal(request.revision, project.revision);
    const samples = await prepareTalkVoiceAudition(project, directory, tools.ffmpegPath, request);
    return { original: Buffer.from(samples.original).toString('base64'), enhanced: Buffer.from(samples.enhanced).toString('base64') };
  });
  const edits = [], exports = [];
  await page.exposeFunction('__saveHighlight', async (id, revision, edit) => {
    assert.equal(id, project.id);
    assert.equal(revision, project.revision);
    const clip = editTalkHighlight(project, edits.find(item => item.id === edit.id), edit);
    edits.splice(0, edits.length, clip);
    return { version: 1, goal: '', items: edits };
  });
  await page.exposeFunction('__exportTalk', async (id, kind, options) => {
    assert.equal(id, project.id);
    exports.push({ kind, options });
    return null;
  });
  await page.evaluateOnNewDocument(initial => {
    window.__ttsCalls = 0;
    const forbidden = async () => { window.__ttsCalls++; throw new Error('TTS must not be invoked'); };
    window.voxweave = {
      getStatus: async () => ({ state: 'missing', backend: 'none', message: 'No TTS installed' }),
      semanticStatus: async () => ({ configured: false, enginePath: '', modelPath: '' }),
      listAssets: async () => [], listVoices: async () => [], resumeLastProject: async () => null,
      onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      generateComposition: forbidden, synthesize: forbidden,
      talkingHead: {
        status: async () => ({ ready: true, message: '识别资源就绪' }),
        resume: async () => initial,
        onProgress: () => () => {}, onExportProgress: () => () => {},
        update: (id, change) => window.__talkUpdate(id, change),
        highlights: async () => ({ version: 1, goal: '', items: [] }),
        findHighlights: async () => ({ version: 1, goal: '', items: [] }),
        saveHighlight: (id, revision, edit) => window.__saveHighlight(id, revision, edit),
        export: (id, kind, options) => window.__exportTalk(id, kind, options),
        auditionVoice: async (id, request) => {
          const samples = await window.__talkAudition(id, request);
          return { original: Uint8Array.fromBase64(samples.original).buffer, enhanced: Uint8Array.fromBase64(samples.enhanced).buffer };
        }
      }
    };
  }, initial);
  await page.goto(base);
  const mode = await page.$('.workflow-nav button:nth-of-type(2)'); await mode.click();
  await page.waitForSelector('.talk-cue textarea');
  await page.waitForFunction(() => !document.querySelector('.talk-cue textarea').disabled);
  await page.waitForFunction(() => document.querySelector('.talk-stage hyperframes-player')?.duration > 0);
  const dimensions = await page.$eval('.talk-stage', element => ({ width: element.clientWidth, height: element.clientHeight,
    cssWidth: getComputedStyle(element).width, cssHeight: getComputedStyle(element).height, aspect: getComputedStyle(element).aspectRatio }));
  assert.ok(Math.abs(dimensions.width / dimensions.height - project.source.width / project.source.height) < .02, `Preview must preserve video aspect ratio: ${JSON.stringify(dimensions)}`);
  const sourceTokens = JSON.stringify(project.cues.map(cue => cue.tokens)), cuts = JSON.stringify(project.cuts);
  await page.$eval('.talk-cue textarea', element => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, '声织|口播精剪。');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  async function clickButton(label) {
    const button = await page.waitForSelector(`::-p-aria([name="${label}"][role="button"])`, { visible: true });
    await button.click();
  }
  const enhancement = 'select[aria-label="人声增强"]';
  await page.click('.talk-audio > summary');
  await page.select(enhancement, 'warm');
  await clickButton('试听对比');
  await clickButton('试听原声');
  await page.waitForFunction(() => document.querySelector('.talk-audio audio').currentTime > .05);
  await clickButton('试听增强');
  await page.waitForFunction(() => document.querySelector('.talk-audio button[aria-pressed=true]')?.textContent === '试听增强'
    && document.querySelector('.talk-audio audio').currentTime > .05);
  assert.equal(project.audio.voiceEnhancement, 'off');
  await clickButton('应用增强');
  await page.waitForFunction(() => !document.querySelector('select[aria-label="人声增强"]').disabled);
  assert.equal(project.audio.voiceEnhancement, 'warm');
  assert.equal(calls.at(-1).edits, undefined);
  assert.equal(await page.$eval('.talk-cue textarea', element => element.value), '声织|口播精剪。');
  await page.select(enhancement, 'off');
  await clickButton('关闭增强');
  await page.waitForFunction(() => !document.querySelector('select[aria-label="人声增强"]').disabled);
  assert.equal(project.audio.voiceEnhancement, 'off');
  await page.click('.talk-audio > summary');
  await page.click('.talk-editor-toolbar button');
  await page.waitForFunction(() => document.querySelector('.talk-notice')?.textContent.includes('已保存') && !document.querySelector('.talk-cue textarea').disabled);
  assert.equal(project.cues[0].text, '声织|口播精剪。');
  assert.equal(JSON.stringify(project.cuts), cuts); assert.equal(JSON.stringify(project.cues.map(cue => cue.tokens)), sourceTokens);
  await page.select('select[aria-label="口播字幕出现方式"]', 'phrase');
  await page.waitForFunction(() => !document.querySelector('.talk-cue textarea').disabled);
  assert.equal(project.captions.reveal, 'phrase');
  await page.waitForFunction(() => document.querySelector('.talk-stage hyperframes-player')?.duration > 0);
  await page.evaluate(() => { const player = document.querySelector('.talk-stage hyperframes-player'); player.seek(.3); player.play(); });
  await page.waitForFunction(() => document.querySelector('.talk-stage hyperframes-player').currentTime > .55);
  await page.evaluate(() => document.querySelector('.talk-stage hyperframes-player').pause());
  await page.screenshot({ path: path.join(root, 'ui-captions.png') });
  await page.click('.talk-tabs button:nth-of-type(2)');
  const cutCount = project.cuts.filter(cut => cut.applied).length;
  assert.ok(cutCount > 0);
  const restore = await page.$('.talk-cut.applied .talk-actions button:nth-of-type(2)'); await restore.click();
  await page.waitForFunction(expected => document.querySelectorAll('.talk-cut.applied').length === expected && !document.querySelector('input[aria-label="手动剪辑起点"]').disabled, {}, cutCount - 1);
  assert.equal(project.cuts.filter(cut => cut.applied).length, cutCount - 1);
  await page.click('.talk-cut .talk-actions button:first-of-type');
  await page.waitForSelector('video');
  assert.ok(await page.$('.talk-dialog[aria-labelledby="talk-source-title"]'));
  await page.click('button[aria-label="关闭原片试听"]');
  await page.waitForSelector('.talk-dialog', { hidden: true });
  await page.click('.talk-tabs button:nth-of-type(3)');
  await page.waitForSelector('select[aria-label="口播增强类型"]');
  await page.select('select[aria-label="口播增强类型"]', 'whiteboard');
  await page.$eval('textarea[aria-label="图解文字"]', element => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, '原声驱动\n字幕随行');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.talk-editor > .talk-primary');
  await page.waitForFunction(() => !document.querySelector('select[aria-label="口播增强类型"]').disabled);
  assert.equal(project.overlays[0].text, '原声驱动\n字幕随行');
  await page.waitForFunction(() => document.querySelector('.talk-stage hyperframes-player')?.duration > 0);
  await page.evaluate(() => { const player = document.querySelector('.talk-stage hyperframes-player'); player.seek(.4); player.play(); });
  await page.waitForFunction(() => document.querySelector('.talk-stage hyperframes-player').currentTime > .65);
  await page.evaluate(() => document.querySelector('.talk-stage hyperframes-player').pause());
  await page.screenshot({ path: path.join(root, 'ui-visuals.png') });
  await page.click('.workflow-nav button:first-of-type');
  await page.waitForFunction(() => !document.querySelector('.workflow-pane').hidden);
  assert.ok(await page.$('.script-field textarea'));
  await page.click('.workflow-nav button:nth-of-type(2)');
  assert.equal(await page.$eval('textarea[aria-label="图解文字"]', element => element.value), '原声驱动\n字幕随行');
  await page.click('.talk-framing > summary');
  await page.select('.talk-framing select', '9:16');
  await clickButton('应用画幅与取景');
  await page.waitForFunction(() => document.querySelector('.talk-metadata')?.textContent.includes('1080 × 1920'));
  assert.equal(project.framing.aspect, '9:16');
  await clickButton('精彩片段');
  await clickButton('提取精彩片段');
  await page.waitForFunction(() => document.querySelector('.talk-highlights .talk-notice')?.textContent.includes('没有新的'));
  await clickButton('手动添加');
  await page.type('.highlight-edit input:not([type=number])', '测试发布片段');
  await clickButton('保存片段');
  await page.waitForSelector('.highlight-card');
  await clickButton('试听原片');
  await page.waitForSelector('.talk-dialog video');
  await page.click('button[aria-label="关闭原片试听"]');
  await page.click('.highlight-card .publish-panel summary');
  await page.select('.highlight-card .publish-panel select', 'xiaohongshu');
  await clickButton('保存 MP4、封面和文案');
  assert.equal(exports[0]?.options.highlightId, edits[0].id);
  assert.equal(exports[0]?.options.draft.platform, 'xiaohongshu');
  assert.equal(exports[0]?.kind, 'publish');
  assert.equal(await page.evaluate(() => window.__ttsCalls), 0);
  assert.deepEqual(errors, []);
  await page.setViewport({ width: 800, height: 1000 });
  await page.screenshot({ path: path.join(root, 'ui-narrow.png') });
  await writeFile(path.join(root, 'ui-report.json'), JSON.stringify({ ok: true, calls, exports, ttsCalls: 0, errors }, null, 2));
  process.stdout.write('Talking-head UI smoke passed: voice audition, corrections, graphics, portrait framing, clip review, publish bundle request, no TTS.\n');
} finally { await browser.close(); }
