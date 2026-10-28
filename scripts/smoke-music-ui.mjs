import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createDraftEditPlan } from '../dist-electron/shared/edit-plan.js';

const plan = createDraftEditPlan({ id: 'music-ui-check', script: '免费配乐界面检查。', voiceId: 'vivian' });
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const audioUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(({ plan, audioUrl }) => {
    let saved = plan;
    const assets = [];
    const preview = { entryUrl: 'about:blank', durationMs: 2000, width: 1080, height: 1920 };
    window.__calls = []; window.__musicFailure = false;
    const track = { id: '0b2b8bcb-35f4-4a8e-852b-92a50f7c91e8', name: 'Piano Remix', author: 'Composer', provider: 'freesound',
      durationMs: 110773, previewUrl: audioUrl, sourceUrl: 'https://freesound.org/people/composer/sounds/112071/',
      license: 'cc0', licenseVersion: '1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Required music credit', tags: ['钢琴', 'music'] };
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: 'ready' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }), listVoices: async () => [],
      resumeLastProject: async () => ({ plan: saved, preview }), onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      listAssets: async () => assets, searchAssets: async (_query, type) => assets.filter(asset => !type || type === asset.type),
      pexelsStatus: async () => ({ configured: false }),
      searchMusic: async request => {
        window.__calls.push({ search: request });
        if (window.__musicFailure) throw new Error('Openverse 请求较多，请稍后再试');
        const item = request.license === 'cc0-by' ? { ...track, license: 'by', licenseVersion: '4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' } : track;
        return { items: [item], query: 'piano music', page: request.page, pageCount: 2 };
      },
      downloadMusic: async id => {
        window.__calls.push({ download: id });
        const asset = { id: 'music-local', filePath: '/music/piano.mp3', name: track.name, type: 'audio', hasAudio: true, durationMs: track.durationMs,
          tags: track.tags, autoTags: track.tags, manualTags: [], license: { status: 'licensed', source: 'openverse', author: track.author,
            sourceUrl: track.sourceUrl, licenseUrl: track.licenseUrl, note: 'CC0 1.0\nRequired music credit' } };
        assets.push(asset); return asset;
      },
      updateAudio: async (_id, settings) => {
        window.__calls.push({ audio: settings });
        saved = { ...saved, audio: settings.audio, bgm: settings.bgm, output: { ...saved.output, playbackRate: settings.playbackRate } };
        return { plan: saved, preview };
      },
      openSource: async url => { window.__calls.push({ source: url }); }
    };
  }, { plan, audioUrl });
  await page.goto(process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178');
  await page.click('.more-toggle'); await page.waitForSelector('.bgm-controls');
  await page.click('.bgm-controls button');
  await page.waitForSelector('select[aria-label="素材类型"]');
  assert.equal(await page.$eval('select[aria-label="素材类型"]', el => el.value), 'audio');
  await page.waitForSelector('.library-empty button'); await page.click('.library-empty button');
  assert.equal(await page.$eval('[aria-label="音乐许可"]', el => el.value), 'cc0');
  await page.click('.music-panel button[type=submit]'); await page.waitForSelector('.music-card');
  assert.equal(await page.$eval('.music-license', el => el.textContent), 'CC0 1.0 · 无需署名');
  await page.click('.music-card button'); await page.waitForSelector('.music-preview audio');
  assert.equal(await page.$eval('.music-preview audio', el => el.getAttribute('src')), audioUrl);
  await page.click('.music-card summary');
  assert.ok(await page.$eval('.music-credits', el => el.textContent.includes('Required music credit')));
  await page.$$eval('.music-credits button', buttons => buttons.find(button => button.textContent.includes('查看许可')).click());
  await page.waitForFunction(() => window.__calls.some(call => call.source?.includes('creativecommons.org')));
  await page.$$eval('.music-panel > .library-toolbar button', buttons => buttons.find(button => button.textContent.includes('下一页')).click());
  await page.waitForFunction(() => window.__calls.some(call => call.search?.page === 2));
  await page.select('[aria-label="音乐许可"]', 'cc0-by');
  await page.click('.music-panel button[type=submit]'); await page.waitForSelector('.music-card');
  assert.equal(await page.$eval('.music-license', el => el.textContent), 'CC BY 4.0 · 需署名');
  await page.select('[aria-label="音乐许可"]', 'cc0');
  await page.click('.music-panel button[type=submit]'); await page.waitForSelector('.music-card');
  await page.$$eval('.music-card > button', buttons => buttons.find(button => button.textContent.includes('下载入库')).click());
  await page.waitForFunction(() => [...document.querySelectorAll('.music-card button')].some(button => button.textContent === '已入库' && button.disabled));
  await mkdir('.windows-smoke/music-ui', { recursive: true });
  await page.screenshot({ path: '.windows-smoke/music-ui/desktop.png' });
  await page.setViewport({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: '.windows-smoke/music-ui/mobile.png' });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.$$eval('.music-card > button', buttons => buttons.find(button => button.textContent.includes('用作配乐')).click());
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  assert.equal(await page.$eval('.bgm-controls select', el => el.value), 'music-local');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.download).length), 1);
  await page.click('.generate-button');
  await page.waitForFunction(() => window.__calls.some(call => call.audio?.bgm.assetId === 'music-local' && call.audio.bgm.enabled));
  await page.click('.bgm-controls button'); await page.waitForSelector('.asset-card');
  assert.ok(await page.$eval('.asset-card', el => el.textContent.includes('Openverse · Composer') && el.textContent.includes('Required music credit')));
  await page.click('.library-tabs button:nth-child(3)');
  await page.evaluate(() => { window.__musicFailure = true; });
  await page.click('.music-panel button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.music-panel [role=alert]')?.textContent.includes('稍后再试'));
  assert.equal(await page.$eval('.music-panel button[type=submit]', el => el.disabled), false);
  assert.deepEqual(errors, []);
  console.log('Music UI smoke passed: CC0 default, search/pagination, single-player preview, license and credit, CC BY opt-in, download reuse, BGM selection/apply, persisted metadata, mobile layout, quota error recovery.');
} finally { await browser.close(); }
