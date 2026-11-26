import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    let assets = ['城市夜景', '办公室团队', '舒缓钢琴 BGM'].map((name, index) => ({ id: String(index), name,
      type: index === 2 ? 'audio' : 'video', tags: ['城市', 'city'], autoTags: ['城市', 'city'], manualTags: [],
      license: { source: 'user-import', status: 'user-owned' }, durationMs: 5000, width: index === 2 ? undefined : 1920, height: 1080 }));
    window.__calls = [];
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: '本地引擎就绪' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }),
      listVoices: async () => [],
      listAssets: async () => assets, searchAssets: async (query, type) => assets.filter(asset => (!type || asset.type === type) && (!query || asset.name.includes(query) || asset.tags.includes(query))),
      resumeLastProject: async () => null, onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      pexelsStatus: async () => ({ configured: true }),
      importAssets: async () => ({ assets: [], errors: [] }),
      updateAssetTags: async (ids, tags, mode) => { window.__calls.push({ ids, tags, mode }); assets = assets.map(asset => ids.includes(asset.id) ? { ...asset, manualTags: tags, tags: [...asset.autoTags, ...tags] } : asset); },
      autoTagAssets: async () => {}, removeAssets: async ids => { assets = assets.filter(asset => !ids.includes(asset.id)); },
      searchPexels: async request => ({ query: 'office', items: [{ id: 'pexels-image-1', type: 'image', name: 'Office team', width: 1920, height: 1080,
        author: 'Demo Photographer', sourceUrl: 'https://www.pexels.com/photo/1/', thumbnailUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' }] }),
      downloadPexels: async id => { window.__calls.push({ download: id }); return assets[0]; }, openSource: async () => {}, configurePexels: async () => {}
    };
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178');
  await page.waitForSelector('.library-button');
  await page.click('.library-button');
  await page.waitForSelector('.asset-card');
  assert.equal(await page.$$eval('.asset-card', cards => cards.length), 3);
  await page.click('.asset-select input');
  await page.type('.tag-editor input', '品牌');
  await page.click('.tag-editor button');
  await page.waitForFunction(() => window.__calls.some(call => call.tags?.includes('品牌')));
  await mkdir('.windows-smoke/ui-check', { recursive: true });
  await page.screenshot({ path: '.windows-smoke/ui-check/library-desktop.png' });
  await page.click('.library-tabs button:nth-child(2)');
  assert.equal(await page.$eval('.pexels-config', details => details.open), false);
  await page.click('.pexels-config summary');
  const keyControls = await page.$$eval('.pexels-key-row input,.pexels-key-row button', elements =>
    elements.map(element => ({ top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom })));
  assert.ok(keyControls.every(control => Math.abs(control.bottom - keyControls[0].bottom) <= 1));
  await page.click('.pexels-config summary');
  await page.type('input[aria-label="搜索 Pexels 素材"]', '办公室');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.body.textContent.includes('实际搜索词：office'));
  await page.click('.asset-card button:last-child');
  await page.waitForFunction(() => window.__calls.some(call => call.download));
  assert.ok(await page.$eval('.asset-card button:last-child', button => button.disabled));
  await page.setViewport({ width: 375, height: 812 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.screenshot({ path: '.windows-smoke/ui-check/library-mobile.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.keyboard.press('Escape');
  assert.equal(await page.$('[role=dialog]'), null);
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'library-button');
  assert.ok(await page.$eval('.workspace-header', header => {
    const mode = header.querySelector('.workflow-nav').getBoundingClientRect();
    const actions = header.querySelector('.workspace-actions').getBoundingClientRect();
    return actions.left >= mode.right && actions.right <= innerWidth;
  }));
  await page.click('.workflow-nav button:nth-child(2)');
  await page.waitForSelector('.talk-app', { visible: true });
  assert.equal(await page.$$eval('.library-button', buttons => buttons.length), 1);
  await page.click('.workspace-actions .icon-button');
  await page.waitForSelector('.creation-settings', { visible: true });
  await page.keyboard.press('Escape');
  await page.click('.workspace-actions .library-button');
  await page.waitForSelector('.asset-card', { visible: true });
  assert.equal(await page.$$eval('.asset-card', cards => cards.length), 3);
  console.log('UI smoke passed: shared library and settings in both modes, local tags, Pexels mocks, responsive layout and keyboard focus.');
} finally { await browser.close(); }
