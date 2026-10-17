import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  OcrEngine,
  Ps5AccountProfile,
  Ps5Frame,
  Ps5HostInfo,
  Ps5HostTestResult,
  Ps5RuntimeStatus,
  Ps5StreamResolution,
  StreamSourceProfile,
  TemplateCreatePayload,
  TemplateDefinition,
  TemplateFolder,
  TemplateUpdatePatch,
  WorkflowDocument,
  WorkflowRunEvent,
  WorkflowRunHandle,
  WorkflowRunSnapshot,
  YoloAnnotation,
  YoloDatasetImportResult,
  YoloTrainConfig,
  YoloTrainingEvent,
  YoloTrainingState,
} from '@nobowo/core';

contextBridge.exposeInMainWorld('electronAPI', {
  // 后续扩展：执行引擎通信、文件操作等
});

contextBridge.exposeInMainWorld('workflowAPI', {
  getExecutorVersion: (): Promise<string> => ipcRenderer.invoke('workflow:getExecutorVersion'),
  getState: (): Promise<WorkflowRunSnapshot> => ipcRenderer.invoke('workflow:getState'),
  run: (workflow: WorkflowDocument): Promise<WorkflowRunHandle> => ipcRenderer.invoke('workflow:run', workflow),
  pause: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('workflow:pause'),
  resume: (opts?: { retry?: boolean }): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('workflow:resume', opts),
  stop: (): Promise<{ ok: boolean; message?: string }> => ipcRenderer.invoke('workflow:stop'),
  setControlWindowInteractive: (interactive: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('workflow:controlWindowInteractive', interactive),
  returnToWorkbench: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('workflow:returnToWorkbench'),
  onEvent: (cb: (event: WorkflowRunEvent) => void): (() => void) => {
    const listener = (_event: unknown, data: WorkflowRunEvent) => cb(data);
    ipcRenderer.on('workflow:event', listener);
    return () => ipcRenderer.removeListener('workflow:event', listener);
  },
  onOpenDebugPanel: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on('workflow:ui:openDebugPanel', listener);
    return () => ipcRenderer.removeListener('workflow:ui:openDebugPanel', listener);
  },
  onControlHolding: (cb: (data: { progress: number; activating: boolean }) => void): (() => void) => {
    const listener = (_event: unknown, data: { progress: number; activating: boolean }) => cb(data);
    ipcRenderer.on('workflow:control:holding', listener);
    return () => ipcRenderer.removeListener('workflow:control:holding', listener);
  },
});

contextBridge.exposeInMainWorld('keyboardRecordAPI', {
  start: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('keyboardRecord:start'),
  stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('keyboardRecord:stop'),
  onKeyEvent: (cb: (data: { type: 'keyDown' | 'keyUp'; key: string; code: string }) => void): (() => void) => {
    const listener = (_event: unknown, data: { type: 'keyDown' | 'keyUp'; key: string; code: string }) => cb(data);
    ipcRenderer.on('keyboardRecord:event', listener);
    return () => ipcRenderer.removeListener('keyboardRecord:event', listener);
  },
});

contextBridge.exposeInMainWorld('cloudApiAPI', {
  list: () => ipcRenderer.invoke('cloudApi:list'),
  create: (payload: { name: string; baseUrl: string; apiKey: string; defaultPrompt?: string }) =>
    ipcRenderer.invoke('cloudApi:create', payload),
  update: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultPrompt?: string }) =>
    ipcRenderer.invoke('cloudApi:update', id, patch),
  remove: (id: string) => ipcRenderer.invoke('cloudApi:remove', id),
  test: (payload: { baseUrl: string; apiKey: string; name?: string }) => ipcRenderer.invoke('cloudApi:test', payload),
  vision: (payload: { imageDataUrl: string; profileId: string; prompt?: string }) =>
    ipcRenderer.invoke('cloudApi:vision', payload),
});

contextBridge.exposeInMainWorld('ocrAPI', {
  listEngines: () => ipcRenderer.invoke('ocr:listEngines'),
  run: (payload: { engine: OcrEngine; lang?: string; imageDataUrl: string; targetText?: string; width?: number; height?: number }) =>
    ipcRenderer.invoke('ocr:run', payload),
  langStatus: () => ipcRenderer.invoke('ocr:langStatus'),
  installLangData: (payload?: { lang?: string }) => ipcRenderer.invoke('ocr:installLangData', payload),
  onProgress: (callback: (data: { level: 'info' | 'warn' | 'error' | 'debug'; message: string; percent?: number; timestamp: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { level: 'info' | 'warn' | 'error' | 'debug'; message: string; percent?: number; timestamp: number }) => {
      callback(data);
    };
    ipcRenderer.on('ocr:progress', listener);
    return () => {
      ipcRenderer.removeListener('ocr:progress', listener);
    };
  },
});

contextBridge.exposeInMainWorld('streamAPI', {
  list: () => ipcRenderer.invoke('stream:list'),
  create: (payload: Omit<StreamSourceProfile, 'id' | 'createdAt' | 'updatedAt'>) =>
    ipcRenderer.invoke('stream:create', payload),
  update: (id: string, patch: Partial<Omit<StreamSourceProfile, 'id' | 'createdAt' | 'updatedAt'>>) =>
    ipcRenderer.invoke('stream:update', id, patch),
  remove: (id: string) => ipcRenderer.invoke('stream:remove', id),
  testConnection: (payload: { host?: string; port?: number; url?: string; name?: string }) =>
    ipcRenderer.invoke('stream:testConnection', payload),
  probeWindows: () => ipcRenderer.invoke('stream:probeWindows'),
  captureWindow: (sourceId: string) => ipcRenderer.invoke('stream:captureWindow', sourceId),
  captureSource: (sourceId: string) => ipcRenderer.invoke('stream:captureSource', sourceId),
  captureScreenshot: (payload: { source: 'screen' | 'window' | 'stream'; streamSourceId?: string; windowHint?: string }) =>
    ipcRenderer.invoke('stream:captureScreenshot', payload),
});

contextBridge.exposeInMainWorld('ps5API', {
  status: (): Promise<Ps5RuntimeStatus> => ipcRenderer.invoke('ps5:status'),
  discover: (timeout?: number): Promise<{ devices: Ps5HostInfo[] }> => ipcRenderer.invoke('ps5:discover', timeout),
  getPsnLoginUrl: (): Promise<{ url: string }> => ipcRenderer.invoke('ps5:getPsnLoginUrl'),
  loginAndLookup: (): Promise<{ onlineId: string; accountId: string; source: string }> =>
    ipcRenderer.invoke('ps5:loginAndLookup'),
  lookupAccountIdFromRedirect: (redirectUrl: string): Promise<{ onlineId: string; accountId: string; source: string }> =>
    ipcRenderer.invoke('ps5:lookupAccountIdFromRedirect', redirectUrl),
  listAccounts: (): Promise<{ accounts: Ps5AccountProfile[] }> => ipcRenderer.invoke('ps5:listAccounts'),
  saveAccount: (payload: Partial<Ps5AccountProfile> & { onlineId: string; accountId: string }): Promise<{ account: Ps5AccountProfile }> =>
    ipcRenderer.invoke('ps5:saveAccount', payload),
  removeAccount: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('ps5:removeAccount', id),
  listHosts: (): Promise<{ hosts: Array<{ host: string; accountId: string; updatedAt: number }> }> =>
    ipcRenderer.invoke('ps5:listHosts'),
  testHost: (host: string): Promise<Ps5HostTestResult> => ipcRenderer.invoke('ps5:testHost', host),
  pair: (payload: { host: string; accountId: string; pin: string }): Promise<{ host: string; accountId: string }> =>
    ipcRenderer.invoke('ps5:pair', payload),
  connect: (payload: { host: string; accountId: string; resolution?: Ps5StreamResolution; fps?: number; quality?: string }): Promise<Ps5RuntimeStatus> =>
    ipcRenderer.invoke('ps5:connect', payload),
  disconnect: (): Promise<{ connected: boolean }> => ipcRenderer.invoke('ps5:disconnect'),
  getFrame: (): Promise<Ps5Frame> => ipcRenderer.invoke('ps5:getFrame'),
  sendKey: (key: string, down: boolean): Promise<{ key: string; button: string; down: boolean }> =>
    ipcRenderer.invoke('ps5:sendKey', key, down),
  sendButton: (action: string, pressed?: boolean, durationMs = 0): Promise<{ action: string; button: string }> =>
    ipcRenderer.invoke('ps5:sendButton', action, pressed, durationMs),
  setStick: (stick: 'left' | 'right', x: number, y: number): Promise<{ stick: string; x: number; y: number }> =>
    ipcRenderer.invoke('ps5:setStick', stick, x, y),
});

contextBridge.exposeInMainWorld('engineAPI', {
  envInfo: () => ipcRenderer.invoke('engine:envInfo'),
  templateMatch: (payload: { imageDataUrl: string; templateId?: string; templatePath?: string; threshold?: number }) =>
    ipcRenderer.invoke('engine:templateMatch', payload),
  yoloDetect: (payload: { imageDataUrl: string; modelId?: string; modelPath?: string; threshold?: number }) =>
    ipcRenderer.invoke('engine:yoloDetect', payload),
  installChiaki: (platform: string) => ipcRenderer.invoke('engine:installChiaki', platform),
});

contextBridge.exposeInMainWorld('templateAPI', {
  list: () => ipcRenderer.invoke('templates:list'),
  create: (payload: TemplateCreatePayload) => ipcRenderer.invoke('templates:create', payload),
  update: (id: string, patch: TemplateUpdatePatch) => ipcRenderer.invoke('templates:update', id, patch),
  createFolder: (payload: { name: string; parentId?: string | null }) => ipcRenderer.invoke('templates:createFolder', payload),
  updateFolder: (id: string, patch: { name?: string; parentId?: string | null }) => ipcRenderer.invoke('templates:updateFolder', id, patch),
  removeFolder: (id: string, moveTemplatesTo?: string | null) => ipcRenderer.invoke('templates:removeFolder', id, { moveTemplatesTo }),
  batchUpdate: (ids: string[], patch: TemplateUpdatePatch) => ipcRenderer.invoke('templates:batchUpdate', ids, patch),
  batchDelete: (ids: string[]) => ipcRenderer.invoke('templates:batchDelete', ids),
  export: (ids: string[]) => ipcRenderer.invoke('templates:export', ids),
  remove: (id: string) => ipcRenderer.invoke('templates:delete', id),
  getImage: (id: string, kind: 'template' | 'source' = 'template') =>
    ipcRenderer.invoke('templates:image', id, kind),
});

contextBridge.exposeInMainWorld('yoloAPI', {
  listDatasets: () => ipcRenderer.invoke('yolo:listDatasets'),
  createDataset: (payload: { name: string; notes?: string }) => ipcRenderer.invoke('yolo:createDataset', payload),
  updateDataset: (id: string, patch: { name?: string; notes?: string }) => ipcRenderer.invoke('yolo:updateDataset', id, patch),
  removeDataset: (id: string) => ipcRenderer.invoke('yolo:removeDataset', id),
  pickDatasetImportPath: (): Promise<string | null> => ipcRenderer.invoke('yolo:pickDatasetImportPath'),
  importDataset: (datasetId: string, sourcePaths: string[]): Promise<YoloDatasetImportResult> =>
    ipcRenderer.invoke('yolo:importDataset', datasetId, sourcePaths),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  importImages: (
    datasetId: string,
    files: { name: string; dataUrl: string; width: number; height: number }[],
  ) => ipcRenderer.invoke('yolo:importImages', datasetId, files),
  listImages: (datasetId: string) => ipcRenderer.invoke('yolo:listImages', datasetId),
  removeImage: (datasetId: string, imageId: string) => ipcRenderer.invoke('yolo:removeImage', datasetId, imageId),
  getImage: (datasetId: string, imageId: string) => ipcRenderer.invoke('yolo:getImage', datasetId, imageId),
  getAnnotations: (datasetId: string) => ipcRenderer.invoke('yolo:getAnnotations', datasetId),
  listClasses: (datasetId: string) => ipcRenderer.invoke('yolo:listClasses', datasetId),
  createClass: (datasetId: string, payload: { name: string }) =>
    ipcRenderer.invoke('yolo:createClass', datasetId, payload),
  removeClass: (datasetId: string, classId: string) => ipcRenderer.invoke('yolo:removeClass', datasetId, classId),
  saveAnnotations: (datasetId: string, imageId: string, annotations: YoloAnnotation[]) =>
    ipcRenderer.invoke('yolo:saveAnnotations', datasetId, imageId, annotations),
  exportDataset: (datasetId: string) => ipcRenderer.invoke('yolo:exportDataset', datasetId),
  listModels: () => ipcRenderer.invoke('yolo:listModels'),
  getActiveModel: () => ipcRenderer.invoke('yolo:getActiveModel'),
  getModelArtifact: (id: string, kind: 'confusionMatrix' | 'prCurve') => ipcRenderer.invoke('yolo:getModelArtifact', id, kind),
  exportModel: (id: string, format: 'onnx' | 'tflite' | 'openvino', imageSize: number) => ipcRenderer.invoke('yolo:exportModel', id, format, imageSize),
  removeModel: (id: string) => ipcRenderer.invoke('yolo:removeModel', id),
  setActiveModel: (id: string) => ipcRenderer.invoke('yolo:setActiveModel', id),
  importModel: (payload: { file: string; name: string; baseModel?: string; imageSize?: number; numClasses?: number }) => ipcRenderer.invoke("yolo:importModel", payload),
  pickModelFile: () => ipcRenderer.invoke("yolo:pickModelFile"),
  getEnvInfo: () => ipcRenderer.invoke('yolo:getEnvInfo'),
  installPackage: (packageNames: string | string[]) => ipcRenderer.invoke('yolo:installPackage', packageNames),
  getYoloxPath: () => ipcRenderer.invoke('yolo:getYoloxPath'),
  setYoloxPath: (path: string) => ipcRenderer.invoke('yolo:setYoloxPath', path),
  pickYoloxPath: () => ipcRenderer.invoke('yolo:pickYoloxPath'),
  installYoloxDeps: () => ipcRenderer.invoke('yolo:installYoloxDeps'),
  getPipMirror: () => ipcRenderer.invoke('yolo:getPipMirror'),
  setPipMirror: (url: string | null) => ipcRenderer.invoke('yolo:setPipMirror', url),
  getGithubProxy: () => ipcRenderer.invoke('yolo:getGithubProxy'),
  setGithubProxy: (url: string | null) => ipcRenderer.invoke('yolo:setGithubProxy', url),
  getWeightsInfo: () => ipcRenderer.invoke('yolo:getWeightsInfo'),
  downloadWeights: (modelName: string) => ipcRenderer.invoke('yolo:downloadWeights', modelName),
  startTraining: (cfg: YoloTrainConfig, datasetId: string) =>
    ipcRenderer.invoke('yolo:startTraining', cfg, datasetId),
  stopTraining: () => ipcRenderer.invoke('yolo:stopTraining'),
  onTrainingEvent: (cb: (event: YoloTrainingEvent) => void) => {
    const listener = (_event: unknown, data: YoloTrainingEvent) => cb(data);
    ipcRenderer.on('yolo:trainingEvent', listener);
    return () => ipcRenderer.removeListener('yolo:trainingEvent', listener);
  },
  onTrainingState: (cb: (state: YoloTrainingState) => void) => {
    const listener = (_event: unknown, data: YoloTrainingState) => cb(data);
    ipcRenderer.on('yolo:trainingState', listener);
    return () => ipcRenderer.removeListener('yolo:trainingState', listener);
  },
  onPackageOutput: (cb: (event: YoloTrainingEvent) => void) => {
    const listener = (_event: unknown, data: YoloTrainingEvent) => cb(data);
    ipcRenderer.on('yolo:packageOutput', listener);
    return () => ipcRenderer.removeListener('yolo:packageOutput', listener);
  },
});
