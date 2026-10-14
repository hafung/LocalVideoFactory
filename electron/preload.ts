import { contextBridge, ipcRenderer } from 'electron';
import type { CompositionProgressEvent, ProgressEvent, SynthesisRequest, VoxWeaveApi } from '../shared/types.js';

const api: VoxWeaveApi = {
  modelSetupStatus: () => ipcRenderer.invoke('models:status'),
  retryModelSetup: () => ipcRenderer.invoke('models:retry'),
  onModelSetupProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, status: import('../shared/model-downloads.js').ModelSetupStatus) => listener(status);
    ipcRenderer.on('models:progress', handler);
    return () => ipcRenderer.removeListener('models:progress', handler);
  },
  getStatus: () => ipcRenderer.invoke('engine:status'),
  configure: config => ipcRenderer.invoke('engine:configure', config),
  semanticStatus: () => ipcRenderer.invoke('semantic:status'),
  configureSemantic: config => ipcRenderer.invoke('semantic:configure', config),
  chooseFile: kind => ipcRenderer.invoke('dialog:choose-file', kind),
  listVoices: () => ipcRenderer.invoke('voice:list'),
  cloneVoice: input => ipcRenderer.invoke('voice:clone', input),
  chooseOutput: (defaultName, format) => ipcRenderer.invoke('dialog:choose-output', defaultName, format),
  createDraftPlan: request => ipcRenderer.invoke('composition:create-draft', request),
  generateComposition: request => ipcRenderer.invoke('composition:generate', request),
  cancelComposition: jobId => ipcRenderer.invoke('composition:cancel', jobId),
  resumeLastProject: () => ipcRenderer.invoke('composition:resume-last'),
  listSceneCandidates: (projectId, sceneId, query, throughSceneId) => ipcRenderer.invoke('composition:scene-candidates', projectId, sceneId, query, throughSceneId),
  replaceScene: (projectId, sceneId, choice) => ipcRenderer.invoke('composition:replace-scene', projectId, sceneId, choice),
  importAssets: () => ipcRenderer.invoke('library:import'),
  importAsset: filePath => ipcRenderer.invoke('library:import-file', filePath),
  listAssets: () => ipcRenderer.invoke('library:list'),
  searchAssets: (query, type) => ipcRenderer.invoke('library:search', query, type),
  updateAssetTags: (ids, tags, mode) => ipcRenderer.invoke('library:tags', { ids, tags, mode }),
  autoTagAssets: ids => ipcRenderer.invoke('library:auto-tags', ids),
  removeAssets: ids => ipcRenderer.invoke('library:remove', ids),
  pexelsStatus: () => ipcRenderer.invoke('pexels:status'),
  configurePexels: key => ipcRenderer.invoke('pexels:configure', key),
  searchPexels: request => ipcRenderer.invoke('pexels:search', request),
  downloadPexels: id => ipcRenderer.invoke('pexels:download', id),
  openSource: url => ipcRenderer.invoke('library:open-source', url),
  updateAudio: (projectId, settings) => ipcRenderer.invoke('composition:audio', projectId, settings),
  exportVideo: projectId => ipcRenderer.invoke('composition:export', projectId),
  exportArtifact: (projectId, kind) => ipcRenderer.invoke('composition:export-artifact', projectId, kind),
  cancelExport: jobId => ipcRenderer.invoke('composition:cancel-export', jobId),
  onExportProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('../shared/types.js').ExportProgress) => listener(payload);
    ipcRenderer.on('composition:export-progress', handler);
    return () => ipcRenderer.removeListener('composition:export-progress', handler);
  },
  synthesize: request => ipcRenderer.invoke('engine:synthesize', request),
  cancel: jobId => ipcRenderer.invoke('engine:cancel', jobId),
  reveal: path => ipcRenderer.invoke('shell:reveal', path),
  openPath: path => ipcRenderer.invoke('shell:open', path),
  onProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ProgressEvent & { jobId: string }) => listener(payload);
    ipcRenderer.on('engine:progress', handler);
    return () => ipcRenderer.removeListener('engine:progress', handler);
  },
  onCompositionProgress: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: CompositionProgressEvent) => listener(payload);
    ipcRenderer.on('composition:progress', handler);
    return () => ipcRenderer.removeListener('composition:progress', handler);
  }
};

contextBridge.exposeInMainWorld('voxweave', api);
