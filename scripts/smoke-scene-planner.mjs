import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDraftEditPlan } from '../dist-electron/shared/edit-plan.js';
import { LocalLlamaScenePlanner } from '../dist-electron/electron/composition/scene-planner.js';
import { resolveSceneModelPaths } from '../dist-electron/electron/composition/scene-model.js';

const root = process.cwd(); const resources = path.join(root, 'resources');
const config = resolveSceneModelPaths(resources, resources);
assert.ok(config.modelPath && config.enginePath, 'Bundled GGUF and llama-server must be installed.');
const planner = new LocalLlamaScenePlanner(() => config);
const results = [];
try {
  for (const script of ['清晨，咖啡师正在研磨咖啡豆。热咖啡缓缓倒入杯中。顾客在窗边享受片刻宁静。', '工厂的质检员正在检查产品。合格产品被打包装箱，准备发货。']) {
    const draft = createDraftEditPlan({ id: 'scene-model-smoke', script, voiceId: 'vivian' });
    const start = Date.now(); const intents = await planner.plan(draft);
    assert.equal(intents.size, draft.scenes.length);
    assert.ok([...intents.values()].every(intent => intent.keywords.length && /[a-zA-Z]{3}/u.test(intent.pexelsQuery)));
    results.push({ script, elapsedMs: Date.now() - start, intents: Object.fromEntries(intents) });
  }
} finally { planner.dispose(); }
const workspace = path.join(root, '.windows-smoke', 'scene-planner'); await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'result.json'), JSON.stringify({ model: path.basename(config.modelPath), results }, null, 2));
console.log(JSON.stringify({ model: path.basename(config.modelPath), results }, null, 2));
