import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { EditPlan, Scene } from '../../shared/edit-plan.js';

export interface SceneSearchIntent { keywords: string[]; pexelsQuery: string }
export interface ScenePlanner { plan(plan: EditPlan, signal?: AbortSignal): Promise<Map<string, SceneSearchIntent>> }

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('无法分配本地端口')));
    });
  });
}

export function parseSceneIntents(value: string, scenes: Scene[]): Map<string, SceneSearchIntent> {
  const text = value.replace(/<think>[\s\S]*?<\/think>/gu, '').trim();
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  const decoded = JSON.parse(text.slice(start, end + 1)) as { scenes?: unknown };
  if (!Array.isArray(decoded.scenes)) throw new Error('分镜模型未返回 scenes 数组');
  const allowed = new Set(scenes.map(scene => scene.id));
  const results = new Map<string, SceneSearchIntent>();
  for (const item of decoded.scenes) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; keywords?: unknown; pexelsQuery?: unknown };
    if (typeof row.id !== 'string' || !allowed.has(row.id) || results.has(row.id) || !Array.isArray(row.keywords)) continue;
    const keywords = row.keywords.filter((word): word is string => typeof word === 'string')
      .map(word => word.trim().slice(0, 80)).filter(Boolean).slice(0, 8);
    const pexelsQuery = typeof row.pexelsQuery === 'string' ? row.pexelsQuery.trim().slice(0, 150) : '';
    if (keywords.length && pexelsQuery) results.set(row.id, { keywords, pexelsQuery });
  }
  return results;
}

/** Local text and sampled-frame planning through llama.cpp's OpenAI-compatible chat endpoint. */
export class LocalLlamaScenePlanner implements ScenePlanner {
  private child?: ChildProcess;
  private endpoint?: string;
  private starting?: Promise<string>;
  private generation = 0;
  private vision = false;
  constructor(private readonly paths: () => { enginePath?: string; modelPath?: string; projectorPath?: string }) {}

  private async start(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.endpoint && this.child?.exitCode === null) return this.endpoint;
    if (this.starting) return this.starting;
    const generation = this.generation;
    this.starting = (async () => {
      const { enginePath, modelPath, projectorPath } = this.paths();
      if (!enginePath || !modelPath || !existsSync(enginePath) || !existsSync(modelPath)) throw new Error('未配置文案分镜模型');
      const port = await availablePort();
      const endpoint = `http://127.0.0.1:${port}`;
      const child = spawn(enginePath, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-ngl', '0', '-c', '8192',
        '--parallel', '1', '--alias', 'voxweave-scene-planner', '--jinja',
        ...(this.vision && projectorPath ? ['--mmproj', projectorPath, '--no-mmproj-offload', '--image-max-tokens', '256'] : [])], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      this.child = child;
      let failed = false;
      let diagnostic = '';
      child.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1500); });
      child.once('error', () => { failed = true; });
      child.once('exit', () => { failed = true; if (this.child === child) this.endpoint = undefined; });
      for (let attempt = 0; attempt < 240; attempt++) {
        if (failed || signal?.aborted || generation !== this.generation) break;
        try {
          const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) });
          if (response.ok && generation === this.generation && !signal?.aborted) { this.endpoint = endpoint; return endpoint; }
        } catch { /* Model loading. */ }
        await delay(250);
      }
      child.kill();
      signal?.throwIfAborted();
      throw new Error(`文案分镜模型启动失败或超时${failed ? `：${diagnostic.slice(-400)}` : ''}`);
    })().finally(() => { if (generation === this.generation) this.starting = undefined; });
    return this.starting;
  }

  enableVision(): void {
    if (!this.paths().projectorPath) throw new Error('缺少 Qwen3.5 视觉投影文件，无法理解原视频画面');
    if (!this.vision) { this.dispose(); this.vision = true; }
  }

  disableVision(): void { if (this.vision) this.dispose(); }

  async json(system: string, data: unknown, signal?: AbortSignal, image?: string | string[], maxTokens = 2048): Promise<unknown> {
    if (image) this.enableVision();
    const endpoint = await this.start(signal);
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voxweave-scene-planner', temperature: 0, max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: image
          ? [{ type: 'text', text: JSON.stringify(data) }, ...(Array.isArray(image) ? image : [image]).flatMap((url, index) => [
            { type: 'text', text: `Frame ${index}` }, { type: 'image_url', image_url: { url } }
          ])]
          : JSON.stringify(data) }] }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
    });
    if (!response.ok) throw new Error(`本地内容模型请求失败（${response.status}）`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content?.replace(/<think>[\s\S]*?<\/think>/gu, '');
    if (!content) throw new Error('本地内容模型返回为空');
    return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  }

  async plan(plan: EditPlan, signal?: AbortSignal): Promise<Map<string, SceneSearchIntent>> {
    const endpoint = await this.start(signal);
    const result = new Map<string, SceneSearchIntent>();
    const batches: Scene[][] = [];
    for (const scene of plan.scenes) {
      let batch = batches.at(-1);
      if (!batch || batch.length >= 8 || batch.reduce((sum, item) => sum + item.script.length, 0) + scene.script.length > 2400) {
        batch = []; batches.push(batch);
      }
      batch.push(scene);
    }
    for (const batch of batches) {
      signal?.throwIfAborted();
      const sceneData = batch.map(scene => ({ id: scene.id, narration: scene.script.slice(0, 2400) }));
      const response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'voxweave-scene-planner', temperature: 0.2, max_tokens: Math.min(2048, 256 + batch.length * 180),
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是短视频分镜策划。根据旁白原文，为每个分镜提出可搜索到的真实素材画面。只理解文字，不要假装看过任何素材。严禁改写旁白或添加原文没有的事实。每个分镜输出3到6个简洁中文检索词，以及一个适合 Pexels 的英文搜索短语。画面应具体、可拍摄、适合作为 B-roll，优先场景、动作、物体，不要抽象概念。严格只返回 JSON：{"scenes":[{"id":"原分镜ID","keywords":["中文词"],"pexelsQuery":"English search phrase"}]}。' },
            { role: 'user', content: JSON.stringify({ storyContext: plan.input.script.slice(0, 1000), scenes: sceneData }) }
          ]
        }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      });
      if (!response.ok) throw new Error(`分镜模型请求失败（${response.status}）`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('分镜模型返回为空');
      for (const [id, intent] of parseSceneIntents(content, batch)) result.set(id, intent);
    }
    if (!result.size) throw new Error('分镜模型没有返回有效的画面意图');
    return result;
  }

  dispose(): void { this.generation++; this.child?.kill(); this.child = undefined; this.endpoint = undefined; this.starting = undefined; this.vision = false; }
}
