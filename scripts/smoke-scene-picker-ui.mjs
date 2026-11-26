import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const uiUrl = process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178';
const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 680 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function checkExportRow() {
    const row = await page.$eval('.export-actions', element => {
      const bounds = element.getBoundingClientRect();
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return {
        formats: buttons.length,
        oneRow: buttons.every(button => button.top === buttons[0].top),
        fits: buttons.every(button => button.left >= bounds.left && button.right <= bounds.right + .5)
      };
    });
    assert.deepEqual(row, { formats: 5, oneRow: true, fits: true });
  }
  async function checkThumbnailGrid(columns) {
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('.scene-picker-grid img')].slice(0, 2);
      return images.length === 2 && images.every(image => image.complete && image.naturalWidth >= 720);
    });
    const layout = await page.$eval('.scene-picker-grid', (grid, columns) => {
      const cards = [...grid.querySelectorAll('.scene-picker-card')].slice(0, columns + 1);
      const positions = cards.map(card => card.getBoundingClientRect());
      const body = grid.closest('.scene-picker-body');
      return {
        horizontalOverflow: body.scrollWidth - body.clientWidth,
        alignedRows: positions.slice(0, columns).every(card => card.top === positions[0].top) &&
          positions[columns].top > positions[0].bottom,
        thumbnailsFit: cards.slice(0, 2).every((card, index) => {
          const frame = card.querySelector('.scene-picker-thumb').getBoundingClientRect();
          const image = card.querySelector('img').getBoundingClientRect();
          return Math.abs(frame.width - (positions[index].width - 2)) < 1 &&
            Math.abs(frame.width * 9 / 16 - frame.height) < 1 &&
            Math.abs(frame.width - image.width) < 1 && Math.abs(frame.height - image.height) < 1 &&
            frame.left === image.left && frame.top === image.top;
        })
      };
    }, columns);
    assert.deepEqual(layout, { horizontalOverflow: 0, alignedRows: true, thumbnailsFit: true });
  }
  const [landscape, portrait] = await Promise.all([
    readFile(new URL('../docs/screenshots/music.png', import.meta.url)),
    readFile(new URL('../docs/demos/frameskiff-script.jpg', import.meta.url))
  ]);
  const fixtures = new Map([
    [new URL('/__smoke__/landscape.png', uiUrl).href, { contentType: 'image/png', body: landscape }],
    [new URL('/__smoke__/portrait.jpg', uiUrl).href, { contentType: 'image/jpeg', body: portrait }]
  ]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const fixture = fixtures.get(request.url());
    return fixture ? request.respond(fixture) : request.continue();
  });
  await page.evaluateOnNewDocument(thumbnails => {
    if (window.top !== window) return;
    window.__thumbnails = thumbnails;
    const scene = (id, startMs, endMs, script) => ({ id, startMs, endMs, script, visual: {
      type: 'kinetic-text', intent: { keywords: ['城市'], orientation: 'landscape', preferredTypes: ['video', 'image'] }
    } });
    const plan = { id: 'picker', revision: 1, input: { script: '你好。城市夜景。', visualBrief: '城市夜景' },
      narration: { voiceId: 'vivian' }, bgm: { enabled: false, volume: .15, ducking: true },
      canvas: { width: 1080, height: 1920 }, template: { captionStyle: 'commerce-bold', captionHighlight: 'word' },
      audio: { narrationVolume: 1, originalEnabled: false, originalVolume: .35, originalDucking: true },
      output: { playbackRate: 1.25 }, captions: [],
      scenes: [scene('scene-001', 0, 1500, '你好。'), scene('scene-002', 1500, 4000, '城市夜景。')] };
    const preview = { entryUrl: 'about:blank', durationMs: 3200, width: 1080, height: 1920 };
    window.__calls = [];
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: 'ready' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }),
      listAssets: async () => [], listVoices: async () => [],
      resumeLastProject: async () => ({ plan, preview }),
      onCompositionProgress: () => () => {},
      onExportProgress: callback => { window.__emitExportProgress = callback; return () => {}; },
      listSceneCandidates: async (...args) => {
        window.__calls.push({ candidates: args });
        return {
          query: args[2] || '城市夜景', querySource: args[2] ? 'manual' : 'story',
          candidates: Array.from({ length: 18 }, (_, index) => ({
            asset: { id: `local-${index}`, name: `本地画面 ${index + 1}`, type: index === 0 ? 'video' : 'image', thumbnailPath: 'fixture.png' },
            choice: { type: 'asset', assetId: `local-${index}`, throughSceneId: args[3] }
          }))
        };
      },
      onlineSourceStatus: async () => [{ source: 'wikimedia', types: ['video', 'image'], state: 'ready', automatic: true }],
      searchOnlineMedia: async (_id, request) => {
        window.__calls.push({ search: request });
        const item = (id, type, durationMs) => ({ id, type, durationMs, name: id, source: 'wikimedia',
          thumbnailUrl: thumbnails[type === 'video' ? 0 : 1], previewUrl: thumbnails[type === 'video' ? 0 : 1],
          license: { status: 'licensed', source: 'wikimedia', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Video.webm',
            author: 'Creator', licenseName: 'CC0 1.0' }, width: 1920, height: 1080 });
        return { source: 'wikimedia', query: 'city night', hasMore: false, page: 1, items: request.types.includes('video')
          ? [...Array.from({ length: 17 }, (_, index) => item(`clip-${index}`, 'video', 6000)), item('short', 'video', 2000)]
          : Array.from({ length: 18 }, (_, index) => item(`photo-${index}`, 'image')) };
      },
      downloadOnlineMedia: async (_id, itemId) => {
        window.__calls.push({ download: itemId }); return { asset: { id: 'downloaded', type: 'video' } };
      },
      cancelOnlineMedia: async () => {},
      replaceScene: async (...args) => { window.__calls.push({ replace: args }); return { status: 'replaced', plan, preview }; },
      exportVideo: async () => ({ jobId: 'export' }),
      cancelExport: async jobId => {
        window.__emitExportProgress({ jobId, phase: 'cancelled', progress: 0, message: '已取消导出' });
      },
      exportArtifact: async (_projectId, kind) => {
        window.__calls.push({ artifact: kind });
        return { outputPath: '/mock/captions.ass' };
      },
      openSource: async () => {}
    };
  }, [...fixtures.keys()]);
  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scene-card');
  await page.click('.scene-card button');
  await page.waitForSelector('.scene-picker-card');
  assert.equal(await page.$eval('.scene-picker-current', line => line.textContent), '你好。');
  assert.match(await page.$eval('.scene-picker-extend', button => button.textContent), /延长当前分镜画面到下一句.*城市夜景。/u);
  assert.match(await page.$eval('.scene-picker-secondary', button => button.textContent), /仅用文字做画面/u);

  // Chromium has no Electron library protocol, so load the fixture in the same image elements.
  await page.$$eval('.scene-picker-local .scene-picker-thumb img', images => {
    images.forEach((image, index) => { image.src = window.__thumbnails[index % 2]; });
  });
  await checkThumbnailGrid(2);

  await page.click('.scene-picker-local .scene-picker-card:nth-child(2)');
  assert.equal(await page.$eval('.scene-picker-summary b', name => name.textContent), '本地画面 2');
  assert.equal(await page.$eval('.scene-picker-preview img', img => img.alt), '本地画面 2');

  await page.click('.scene-picker-extend');
  await page.waitForSelector('.scene-picker-included li');
  await page.waitForFunction(() => window.__calls.some(call => call.candidates?.[3] === 'scene-002'));
  assert.equal(await page.$eval('.scene-picker-included li', line => line.textContent), '城市夜景。');
  assert.match(await page.$eval('.scene-picker-summary', summary => summary.textContent), /2 句共用一个画面 · 3.2 秒/u);
  await page.click('.scene-picker-undo');
  await page.waitForSelector('.scene-picker-extend');
  assert.match(await page.$eval('.scene-picker-summary', summary => summary.textContent), /仅用于当前台词 · 1.2 秒/u);
  await page.click('.scene-picker-extend');

  await page.focus('[data-source="local"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.scene-picker-online-card');
  await checkThumbnailGrid(3);
  assert.equal(await page.$eval('[data-source="online"]', tab => tab.getAttribute('aria-selected')), 'true');
  assert.ok(await page.$eval('.online-source-banner', banner => banner.textContent.includes('当前使用 Wikimedia Commons')));
  await page.select('.scene-picker-online-type select', 'image');
  await page.waitForFunction(() => document.querySelector('.scene-picker-online .scene-picker-card b')?.textContent === 'photo-0');
  await page.select('.scene-picker-online-type select', '');
  await page.waitForFunction(() => document.querySelector('.scene-picker-online .scene-picker-card b')?.textContent === 'clip-0');
  const list = '.scene-picker-online';
  const short = `${list} .scene-picker-online-card:last-child .scene-picker-card`;
  assert.equal(await page.$eval(short, button => button.disabled), true);
  assert.equal(await page.$eval('.scene-picker-footer .modal-primary', button => button.disabled), true);
  assert.deepEqual(await page.$$eval('.scene-picker, .scene-picker *', elements => elements
    .filter(element => element.scrollHeight > element.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY))
    .map(element => element.className)), ['scene-picker-body']);

  const card = await page.$(`${list} .scene-picker-online-card:nth-child(2)`);
  const rect = await card.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, Math.min(540, rect.y + 40));
  const footerBefore = await page.$eval('.scene-picker-footer', element => element.getBoundingClientRect().bottom);
  await page.mouse.wheel({ deltaY: 2600 });
  await page.waitForFunction(() => {
    const body = document.querySelector('.scene-picker-body');
    return body.scrollHeight - body.clientHeight - body.scrollTop < 2;
  });
  assert.equal(await page.$eval('.scene-picker-footer', element => element.getBoundingClientRect().bottom), footerBefore);
  assert.equal(await page.$eval('[data-source="online"]', tab => tab.getBoundingClientRect().top > 0), true);

  await page.click('[data-source="local"]');
  await page.click('[data-source="online"]');
  const first = `${list} .scene-picker-online-card:first-child .scene-picker-card`;
  assert.ok(await page.$eval(first, button => button.getBoundingClientRect().top >= document.querySelector('.scene-picker-toolbar').getBoundingClientRect().bottom));
  await page.click(first);
  assert.equal(await page.$eval(first, button => button.getAttribute('aria-pressed')), 'true');
  await page.setViewport({ width: 390, height: 640 });
  await checkThumbnailGrid(2);
  const inset = await page.$eval('.scene-picker', element => {
    const { left, right } = element.getBoundingClientRect();
    return { left, right: window.innerWidth - right };
  });
  assert.ok(inset.left >= 12 && inset.right >= 12, JSON.stringify(inset));
  assert.equal(await page.$eval(first, button => button.getAttribute('aria-pressed')), 'true');
  await page.click('.scene-picker-footer .modal-primary');
  await page.waitForFunction(() => window.__calls.some(call => call.replace));
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.find(call => call.replace).replace[2],
    { type: 'asset', assetId: 'downloaded', sourceInMs: 0, throughSceneId: 'scene-002' });
  assert.ok(calls.some(call => call.search?.types.includes('video') && call.search?.minDurationMs === 4000));
  assert.ok(calls.some(call => call.search?.types.join(',') === 'image'));
  await page.waitForSelector('.scene-picker', { hidden: true });
  await page.setViewport({ width: 960, height: 680 });
  await checkExportRow();
  await page.click('.export-primary');
  await page.waitForSelector('.export-progress-header button');
  await checkExportRow();
  await page.click('.export-progress-header button');
  await page.waitForSelector('.export-progress-header button', { hidden: true });
  await page.click('.export-actions [aria-label="导出 ASS"]');
  await page.waitForFunction(() => window.__calls.some(call => call.artifact === 'ass'));
  await page.waitForSelector('.export-progress-header button');
  await checkExportRow();
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: scene picker, Commons download and apply, and a single export-format row while exporting and after completion.');
} finally { await browser.close(); }
