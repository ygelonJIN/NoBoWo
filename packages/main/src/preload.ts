import { contextBridge, ipcRenderer } from 'electron';
import type {
  TemplateCreatePayload,
  TemplateDefinition,
  TemplateFolder,
  TemplateUpdatePatch,
  YoloAnnotation,
  YoloTrainConfig,
  YoloTrainingEvent,
  YoloTrainingState,
} from '@nobowo/core';

contextBridge.exposeInMainWorld('electronAPI', {
  // 后续扩展：执行引擎通信、文件操作等
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
  removeDataset: (id: string) => ipcRenderer.invoke('yolo:removeDataset', id),
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
  getEnvInfo: () => ipcRenderer.invoke('yolo:getEnvInfo'),
  installPackage: (packageName: string) => ipcRenderer.invoke('yolo:installPackage', packageName),
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
