/// <reference types="vite/client" />

import type {
  CloudApiProfile,
  OcrEngine,
  OcrResult,
  TemplateCreatePayload,
  TemplateDefinition,
  TemplateFolder,
  TemplateUpdatePatch,
  YoloAnnotation,
  YoloDataset,
  YoloEnvInfo,
  YoloImage,
  YoloModel,
  YoloTrainConfig,
  YoloTrainingEvent,
  YoloTrainingState,
} from '@nobowo/core';

declare global {
  interface Window {
    electronAPI: Record<string, never>;
    cloudApiAPI?: {
      list: () => Promise<CloudApiProfile[]>;
      create: (payload: { name: string; baseUrl: string; apiKey: string; defaultPrompt?: string }) => Promise<CloudApiProfile>;
      update: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultPrompt?: string }) => Promise<CloudApiProfile | null>;
      remove: (id: string) => Promise<void>;
      test: (payload: { baseUrl: string; apiKey: string; name?: string }) => Promise<{ ok: boolean; message?: string; lastTestAt: number }>;
    };
    ocrAPI?: {
      run: (payload: { engine: OcrEngine; imageDataUrl: string; targetText?: string; width?: number; height?: number }) => Promise<OcrResult>;
      listEngines: () => Promise<{ available: OcrEngine[]; default: OcrEngine }>;
    };
    templateAPI: {
      list: () => Promise<{ folders: TemplateFolder[]; templates: TemplateDefinition[] }>;
      create: (payload: TemplateCreatePayload) => Promise<TemplateDefinition>;
      update: (id: string, patch: TemplateUpdatePatch) => Promise<TemplateDefinition | null>;
      createFolder: (payload: { name: string; parentId?: string | null }) => Promise<TemplateFolder>;
      updateFolder: (id: string, patch: { name?: string; parentId?: string | null }) => Promise<TemplateFolder | null>;
      removeFolder: (id: string, moveTemplatesTo?: string | null) => Promise<void>;
      batchUpdate: (ids: string[], patch: TemplateUpdatePatch) => Promise<number>;
      batchDelete: (ids: string[]) => Promise<number>;
      export: (ids: string[]) => Promise<{ path: string | null; count: number }>;
      remove: (id: string) => Promise<void>;
      getImage: (id: string, kind?: 'template' | 'source') => Promise<string | null>;
    };
    yoloAPI: {
      listDatasets: () => Promise<YoloDataset[]>;
      createDataset: (payload: { name: string; notes?: string }) => Promise<YoloDataset>;
      updateDataset: (id: string, patch: { name?: string; notes?: string }) => Promise<YoloDataset>;
      removeDataset: (id: string) => Promise<void>;
      importImages: (
        datasetId: string,
        files: { name: string; dataUrl: string; width: number; height: number }[],
      ) => Promise<number>;
      listImages: (datasetId: string) => Promise<YoloImage[]>;
      removeImage: (datasetId: string, imageId: string) => Promise<void>;
      getImage: (datasetId: string, imageId: string) => Promise<string | null>;
      getAnnotations: (datasetId: string) => Promise<Record<string, YoloAnnotation[]>>;
      listClasses: (datasetId: string) => Promise<{ id: string; name: string; color: string }[]>;
      createClass: (datasetId: string, payload: { name: string }) => Promise<{ id: string; name: string; color: string }>;
      removeClass: (datasetId: string, classId: string) => Promise<void>;
      saveAnnotations: (datasetId: string, imageId: string, annotations: YoloAnnotation[]) => Promise<void>;
      exportDataset: (datasetId: string) => Promise<{ path: string }>;
      listModels: () => Promise<YoloModel[]>;
      getActiveModel: () => Promise<YoloModel | null>;
      getModelArtifact: (id: string, kind: 'confusionMatrix' | 'prCurve') => Promise<string | null>;
      exportModel: (id: string, format: 'onnx' | 'tflite' | 'openvino', imageSize: number) => Promise<{ started: boolean; message?: string }>;
      removeModel: (id: string) => Promise<void>;
      setActiveModel: (id: string) => Promise<void>;
      getEnvInfo: () => Promise<YoloEnvInfo>;
      installPackage: (packageName: string) => Promise<{ started: boolean }>;
      startTraining: (cfg: YoloTrainConfig, datasetId: string) => Promise<{ started: boolean; message?: string }>;
      stopTraining: () => Promise<void>;
      onTrainingEvent: (cb: (event: YoloTrainingEvent) => void) => () => void;
      onTrainingState: (cb: (state: YoloTrainingState) => void) => () => void;
      onPackageOutput: (cb: (event: YoloTrainingEvent) => void) => () => void;    };
  }
}

export {};
