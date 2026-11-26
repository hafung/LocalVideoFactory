import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';

const browser = await puppeteer.launch({ executablePath: process.env.VOXWEAVE_CHROME,
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const thumbnailUrl = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    const scene = (id, startMs, endMs, script) => ({ id, startMs, endMs, script, visual: {
      type: 'kinetic-text', intent: { keywords: ['城市'], orientation: 'landscape', preferredTypes: ['video', 'image'] }
    } });
    const plan = { id: 'picker', revision: 1, input: { script: '你好。城市夜景。', visualBrief: '城市夜景' },
      narration: { voiceId: 'vivian' }, bgm: { enabled: false, volume: .15, ducking: true },
      canvas: { width: 1080, height: 1920 }, template: { captionStyle: 'commerce-bold', captionHighlight: 'word' },
      audio: { narrationVolume: 1, originalEnabled: false, originalVolume: .35, originalDucking: true },
      output: { playbackRate: 1 },
      scenes: [scene('scene-001', 0, 1500, '你好。'), scene('scene-002', 1500, 4000, '城市夜景。')] };
    window.__calls = [];
    window.voxweave = {
      getStatus: async () => ({ state: 'idle', backend: 'native', message: 'ready' }),
      semanticStatus: async () => ({ enginePath: '', modelPath: '', configured: false }),
      listAssets: async () => [], listVoices: async () => [],
      resumeLastProject: async () => ({ plan }),
      onCompositionProgress: () => () => {}, onExportProgress: () => () => {},
      listSceneCandidates: async (...args) => { window.__calls.push({ candidates: args });
        return { query: '城市夜景', querySource: 'story', candidates: [] }; },
      pexelsStatus: async () => ({ configured: true }),
      searchPexels: async request => { window.__calls.push({ search: request });
        const item = (id, type, durationMs) => ({ id, type, durationMs, name: id,
          thumbnailUrl, sourceUrl: 'https://www.pexels.com/video/1/', author: 'Creator', width: 1920, height: 1080 });
        return { query: 'city night', items: request.type === 'video'
          ? [item('short', 'video', 2000), item('long', 'video', 6000)] : [item('photo', 'image')] }; },
      downloadPexels: async id => { window.__calls.push({ download: id }); return { id: 'downloaded', type: 'video' }; },
      replaceScene: async (...args) => { window.__calls.push({ replace: args }); return { status: 'replaced', plan }; },
      openSource: async () => {}
    };
  });
  await page.goto(process.env.VOXWEAVE_UI_URL || 'http://127.0.0.1:5178');
  await page.waitForSelector('.scene-card');
  await page.click('.scene-card button');
  await page.waitForSelector('.candidate-scope select');
  await page.select('.candidate-scope select', 'scene-002');
  await page.waitForFunction(() => window.__calls.some(call => call.candidates?.[3] === 'scene-002'));
  await page.waitForSelector('.candidate-online-card');
  assert.equal(await page.$eval('.candidate-online-card:last-child button', button => button.disabled), true);
  await page.click('.candidate-online-card:first-child button');
  await page.waitForFunction(() => window.__calls.some(call => call.replace));
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.find(call => call.replace).replace[2],
    { type: 'asset', assetId: 'downloaded', sourceInMs: 0, throughSceneId: 'scene-002' });
  assert.ok(calls.some(call => call.search?.type === 'video'));
  assert.ok(calls.some(call => call.search?.type === 'image'));
  console.log('Scene picker UI smoke passed: multi-sentence scope, both Pexels types, short-video guard, download and apply.');
} finally { await browser.close(); }
