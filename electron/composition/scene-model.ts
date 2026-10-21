import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function resolveSceneModelPaths(resources: string, modelsRoot: string, override?: string, disabled = false,
  engineOverride?: string): { enginePath?: string; modelPath?: string; projectorPath?: string; bundled?: boolean } {
  if (disabled) return {};
  const enginePath = engineOverride && existsSync(engineOverride) ? engineOverride : path.join(resources, 'semantic', 'runtime', 'llama-server.exe');
  if (!existsSync(enginePath)) return {};
  if (override && existsSync(override) && statSync(override).isFile()) {
    const projectorPath = path.join(path.dirname(override), 'mmproj-F16.gguf');
    return { enginePath, modelPath: override, ...(existsSync(projectorPath) ? { projectorPath } : {}), bundled: false };
  }
  for (const root of [...new Set([resources, modelsRoot])]) {
    const directory = path.join(root, 'scene-planner');
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
      if (typeof manifest.modelFile !== 'string') continue;
      const modelPath = path.resolve(directory, manifest.modelFile);
      if (!modelPath.startsWith(`${path.resolve(directory)}${path.sep}`) || path.extname(modelPath).toLowerCase() !== '.gguf') continue;
      const declared = Array.isArray(manifest.files) ? manifest.files.find((file: { path?: string }) => file.path === manifest.modelFile) : undefined;
      const info = statSync(modelPath);
      if (info.isFile() && info.size > 0 && (!declared?.size || declared.size === info.size)) {
        const projector = typeof manifest.projectorFile === 'string' ? path.resolve(directory, manifest.projectorFile) : '';
        const projection = manifest.files?.find((file: { path?: string }) => file.path === manifest.projectorFile);
        const projectorPath = projector.startsWith(`${path.resolve(directory)}${path.sep}`) && existsSync(projector) &&
          statSync(projector).isFile() && (!projection?.size || statSync(projector).size === projection.size) ? projector : undefined;
        return { enginePath, modelPath, projectorPath, bundled: true };
      }
    } catch { /* Incomplete model resources are not ready. */ }
  }
  return {};
}
