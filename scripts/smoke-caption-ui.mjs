import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDraftEditPlan } from '../dist-electron/shared/edit-plan.js';
import { resolveEditPlan } from '../dist-electron/electron/composition/resolver.js';
import { updateCaptionHighlight } from '../dist-electron/electron/composition/caption-editing.js';
import { compileFixedTemplate } from '../dist-electron/electron/renderers/template-compiler.js';

const root = path.resolve('.windows-smoke/caption-ui');
await mkdir(root, { recursive: true });
const audioPath = path.join(root, 'voice.wav');
const audio = Buffer.alloc(44 + 76800);
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8);
audio.write('fmt ', 12); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); await writeFile(audioPath, audio);
const draft = createDraftEditPlan({ id: 'caption-ui', script: '三个步骤。', voiceId: 'vivian', captionHighlight: 'word' });
let plan = resolveEditPlan(draft, { narration: { audioPath, durationMs: 1600,
  segments: [{ id: 'scene-001', text: '三个步骤。', startMs: 0, endMs: 1600, audioPath }] } });
const base = process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178';
async function prepare() {
  const workspace = path.join(root, `r${plan.revision}`);
  await compileFixedTemplate(plan, workspace);
  return { plan, preview: { entryUrl: `${base}/.windows-smoke/caption-ui/r${plan.revision}/index.html`, durationMs: 1600, width: 1080, height: 1920 } };
}
const initial = await prepare();
const calls = [];
const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.exposeFunction('__updateCaptions', async (id, settings) => {
    assert.equal(id, plan.id); calls.push(settings);
    plan = updateCaptionHighlight(plan, settings.mode, settings.edits);
    return prepare();
  });
  await page.evaluateOnNewDocument(initial => {
    window.__generations = 0;
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: 'ready' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }),
      listAssets: async () => [], listVoices: async () => [], resumeLastProject: async () => initial,
      onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      updateCaptions: (id, settings) => window.__updateCaptions(id, settings),
      generateComposition: async () => { window.__generations++; throw new Error('Caption edits must not synthesize audio'); }
    };
  }, initial);
  await page.goto(base);
  await page.waitForSelector('.caption-controls');
  await page.click('.more-toggle');
  await page.select('select[aria-label="字幕高亮粒度"]', 'phrase');
  await page.click('.caption-controls button:first-of-type');
  await page.waitForFunction(() => document.querySelector('.caption-controls span')?.textContent.includes('按短语') && !document.querySelector('.caption-controls button').disabled);
  assert.deepEqual(plan.captions[0].highlightUnits.map(unit => unit.text), ['三个步骤']);
  const previewPage = await browser.newPage();
  await previewPage.setViewport({ width: 1080, height: 1920 });
  await previewPage.goto((await prepare()).preview.entryUrl);
  await previewPage.waitForFunction(() => !!window.__timelines?.['voxweave-captions']);
  await previewPage.evaluate(() => { window.__timelines['voxweave-kinetics'].seek(.3); window.__timelines['voxweave-captions'].seek(.3); });
  const automatic = await previewPage.evaluate(() => [...document.querySelectorAll('.caption')].filter(element => getComputedStyle(element).visibility === 'visible').map(element => ({ text: element.textContent, selected: element.querySelector('.active')?.textContent })));
  assert.deepEqual(automatic, [{ text: '三个步骤。', selected: '三个步骤' }]);
  await previewPage.screenshot({ path: path.join(root, 'automatic-phrase-highlight.png') });
  await page.bringToFront();
  await page.click('.caption-controls button:nth-of-type(2)');
  await page.waitForSelector('.caption-editor textarea');
  await page.$eval('.caption-editor textarea', element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(element, '三个|步骤。'); element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('.modal .modal-primary');
  await page.waitForFunction(() => !document.querySelector('.caption-editor'));
  assert.deepEqual(plan.captions[0].highlightUnits.map(unit => unit.text), ['三个', '步骤。']);
  assert.equal(await page.evaluate(() => window.__generations), 0);
  assert.equal(calls.length, 2);
  await page.screenshot({ path: path.join(root, 'caption-controls.png') });
  await page.click('.caption-controls button:nth-of-type(2)');
  assert.equal(await page.$eval('.caption-editor textarea', element => element.value), '三个|步骤。');
  await page.screenshot({ path: path.join(root, 'caption-editor.png') });
  await previewPage.bringToFront();
  await previewPage.goto((await prepare()).preview.entryUrl);
  await previewPage.waitForFunction(() => !!window.__timelines?.['voxweave-captions']);
  await previewPage.evaluate(() => { window.__timelines['voxweave-kinetics'].seek(.3); window.__timelines['voxweave-captions'].seek(.3); });
  const active = await previewPage.evaluate(() => [...document.querySelectorAll('.caption')].filter(element => getComputedStyle(element).visibility === 'visible').map(element => ({ text: element.textContent, selected: element.querySelector('.active')?.textContent })));
  assert.deepEqual(active, [{ text: '三个步骤。', selected: '三个' }]);
  await previewPage.screenshot({ path: path.join(root, 'phrase-highlight.png') });
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ ok: true, calls, audioPath, generations: 0, automatic, active }, null, 2));
  console.log('Caption UI smoke passed: mode update, manual split, unchanged audio, real preview highlight.');
} finally { await browser.close(); }
