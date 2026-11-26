import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    let assets = ['城市夜景', '办公室团队', '舒缓钢琴 BGM'].map((name, index) => {
      const autoTags = ['城市', 'city'];
      const manualTags = [['风景'], ['同事'], []][index];
      return { id: String(index), name, type: index === 2 ? 'audio' : 'video',
        tags: [...autoTags, ...manualTags], autoTags, manualTags,
        license: { source: 'user-import', status: 'user-owned' }, durationMs: 5000, width: index === 2 ? undefined : 1920, height: 1080 };
    });
    window.__calls = [];
    let storedKey = false;
    const sourceStatus = () => [
      { source: 'pexels', automatic: true, state: storedKey ? 'ready' : 'missing', storedKey, types: ['video','image'] },
      { source: 'pixabay', automatic: false, state: 'missing', types: ['video','image'] },
      { source: 'coverr', automatic: false, state: 'missing', tier: 'demo', types: ['video'] },
      { source: 'wikimedia', automatic: true, state: 'ready', types: ['video','image'] }
    ];
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: '本地引擎就绪' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }),
      listVoices: async () => [],
      listAssets: async () => assets, searchAssets: async (query, type) => assets.filter(asset => (!type || asset.type === type) && (!query || asset.name.includes(query) || asset.tags.includes(query))),
      resumeLastProject: async () => null, onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      onlineSourceStatus: async () => sourceStatus(),
      importAssets: async () => ({ assets: [], errors: [] }),
      updateAssetTags: async (ids, tags, mode) => {
        window.__calls.push({ ids, tags, mode });
        assets = assets.map(asset => {
          if (!ids.includes(asset.id)) return asset;
          const manualTags = [...new Set([...(mode === 'append' ? asset.manualTags : []), ...tags])];
          return { ...asset, manualTags, tags: [...new Set([...asset.autoTags, ...manualTags])] };
        });
      },
      autoTagAssets: async () => {}, removeAssets: async ids => { assets = assets.filter(asset => !ids.includes(asset.id)); },
      searchOnlineMedia: async (_id, request) => {
        window.__calls.push({ search: request });
        const previewUrl = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        return { source: 'wikimedia', query: 'office', page: 1, hasMore: false,
          items: [{ id: 'wikimedia-image-1', source: 'wikimedia', type: 'image', name: 'Office team', width: 1920, height: 1080,
            license: { source: 'wikimedia', status: 'licensed', author: 'Demo Photographer', licenseName: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
              sourceUrl: 'https://commons.wikimedia.org/wiki/File:Office.jpg' }, thumbnailUrl: previewUrl, previewUrl }] };
      },
      downloadOnlineMedia: async (_id, item) => { window.__calls.push({ download: item }); return { asset: assets[0] }; },
      cancelOnlineMedia: async () => {}, openSource: async () => {}, configureOnlineSource: async ({ source, key }) => {
        window.__calls.push({ configured: source });
        storedKey = Boolean(key);
        return sourceStatus();
      }
    };
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.library-button');
  await page.click('.library-button');
  await page.waitForSelector('.asset-card');
  assert.equal(await page.$$eval('.asset-card', cards => cards.length), 3);
  const firstCard = '.asset-grid .asset-card:nth-child(1)';
  const secondCard = '.asset-grid .asset-card:nth-child(2)';
  const cardEdit = `${firstCard} .asset-edit-tags`;
  const cardInput = `${firstCard} .asset-tag-editor input`;
  await page.click(cardEdit);
  assert.equal(await page.$eval(cardInput, input => input.value), '风景');
  await page.type(cardInput, '草稿');
  await page.keyboard.press('Escape');
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, cardEdit);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.mode).length), 0);
  await page.click(cardEdit);
  assert.equal(await page.$eval(cardInput, input => input.value), '风景');
  await page.$eval(cardInput, input => input.select());
  await page.type(cardInput, '夜拍');
  await page.click(`${firstCard} .asset-tag-editor button[type=submit]`);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('夜拍'), {}, `${firstCard} .asset-tags`);
  assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.mode)), { ids: ['0'], tags: ['夜拍'], mode: 'replace' });
  assert.ok(await page.$eval(`${firstCard} .asset-tags`, tags => tags.textContent.includes('城市')));
  assert.equal(await page.$eval('.library-selection input', input => input.checked), false);
  await page.click(`${secondCard} .asset-thumbnail`);
  await page.click('.asset-preview .asset-edit-tags');
  const previewInput = '.asset-preview .asset-tag-editor input';
  assert.equal(await page.$eval(previewInput, input => input.value), '同事');
  await page.$eval(previewInput, input => input.select());
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.asset-preview p')?.textContent.includes('人工标签：暂无'));
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call.mode).at(-1)), { ids: ['1'], tags: [], mode: 'replace' });
  await page.click('.asset-preview > div button');
  await page.click(`${firstCard} .asset-select input`);
  assert.equal(await page.$('.library-batch-tags'), null);
  await page.click(`${secondCard} .asset-select input`);
  const batchInput = '.library-batch-tags input';
  const batchSubmit = '.library-batch-tags button[type=submit]';
  assert.equal(await page.$eval(batchInput, input => input.value), '');
  assert.equal(await page.$eval(batchSubmit, button => button.disabled), true);
  await page.type(batchInput, '待选');
  await page.click('.asset-grid .asset-card:nth-child(3) .asset-select input');
  assert.equal(await page.$eval(batchInput, input => input.value), '');
  await page.click('.asset-grid .asset-card:nth-child(3) .asset-select input');
  await page.type(batchInput, '精选');
  await page.click(batchSubmit);
  await page.waitForFunction(() => window.__calls.some(call => call.mode === 'append'));
  assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.mode === 'append')),
    { ids: ['0', '1'], tags: ['精选'], mode: 'append' });
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('精选'), {}, `${secondCard} .asset-tags`);
  assert.ok(await page.$eval(`${firstCard} .asset-tags`, tags => tags.textContent.includes('夜拍')));
  assert.ok(await page.$eval(`${secondCard} .asset-tags`, tags => !tags.textContent.includes('夜拍')));
  assert.equal(await page.$eval(batchInput, input => input.value), '');
  await mkdir('.windows-smoke/ui-check', { recursive: true });
  await page.screenshot({ path: '.windows-smoke/ui-check/library-desktop.png' });
  await page.click('.library-tabs button:nth-child(2)');
  await page.waitForFunction(() => document.querySelector('.online-source-banner')?.textContent.includes('Wikimedia Commons'));
  await page.click('.online-alternatives summary');
  assert.ok(await page.$eval('.online-alternatives', details => details.textContent.includes('导入已下载的素材')));
  await page.select('select[aria-label="联网素材类型"]', 'image');
  await page.type('input[aria-label="搜索在线素材"]', '办公室');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.body.textContent.includes('实际搜索词：office'));
  assert.ok(await page.$eval('.online-source-banner', banner => banner.textContent.includes('当前使用 Wikimedia Commons')));
  assert.ok(await page.$eval('.asset-card', card => card.textContent.includes('CC BY 4.0')));
  await page.click('.asset-thumbnail');
  await page.waitForSelector('.asset-preview img');
  await page.click('.asset-card > button:last-child');
  await page.waitForFunction(() => window.__calls.some(call => call.download));
  assert.ok(await page.$eval('.asset-card > button:last-child', button => button.disabled));
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
  await page.waitForFunction(() => document.querySelectorAll('.online-source-setting').length === 4);
  await page.type('input[aria-label="Pexels API Key"]', 'mock-key');
  await page.click('.online-source-setting:first-child button[type=submit]');
  await page.waitForFunction(() => window.__calls.some(call => call.configured === 'pexels'));
  await page.keyboard.press('Escape');
  await page.click('.workspace-actions .library-button');
  await page.waitForSelector('.asset-card', { visible: true });
  assert.equal(await page.$$eval('.asset-card', cards => cards.length), 3);
  console.log('UI smoke passed: single and batch tag editing, shared library, keyless Commons search, license and source settings, responsive layout and keyboard focus.');
} finally { await browser.close(); }
