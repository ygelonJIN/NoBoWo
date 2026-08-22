export type NodeType =
  | 'click'
  | 'input'
  | 'wait'
  | 'screenshot'
  | 'if'
  | 'loop'
  | 'recognize';

export type PortDirection = 'input' | 'output';

export type PortDefinition = {
  id: string;
  label: string;
  direction: PortDirection;
  dataType: string;
  required?: boolean;
};

export type WorkflowNodeBase<TType extends NodeType, TData extends Record<string, unknown>> = {
  id: string;
  type: TType;
  title: string;
  position: {
    x: number;
    y: number;
  };
  width?: number;
  height?: number;
  enabled: boolean;
  data: TData;
};

export type ClickNode = WorkflowNodeBase<'click', {
  // click节点完全依赖识别节点的输出，自己不配置策略
}>;

export type InputNode = WorkflowNodeBase<'input', {
  value: string;
  submit?: boolean;
}>;

export type WaitNode = WorkflowNodeBase<'wait', {
  mode: 'delay' | 'condition';
  delayMs?: number;
  conditionText?: string;
}>;

export type ScreenshotNode = WorkflowNodeBase<'screenshot', {
  regionMode: 'full' | 'selected';
}>;

export type IfNode = WorkflowNodeBase<'if', {
  expression: string;
}>;

export type LoopNode = WorkflowNodeBase<'loop', {
  mode: 'count' | 'condition';
  count?: number;
  conditionText?: string;
}>;

export type OcrEngine = 'auto' | 'macosVision' | 'windowsOcr' | 'tesseract' | 'paddleOcr';

export type CloudApiProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultPrompt: string;
  createdAt: number;
  updatedAt: number;
  lastTestAt?: number | null;
  lastTestStatus?: 'ok' | 'error' | null;
  lastTestMessage?: string | null;
};

export type OcrTextBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrMatch = {
  id: string;
  text: string;
  box: OcrTextBox;
  confidence?: number;
};

export type OcrResult = {
  engine: OcrEngine;
  width: number;
  height: number;
  text: string;
  matches: OcrMatch[];
  message?: string;
};

export type RecognizeNode = WorkflowNodeBase<'recognize', {
  strategies: {
    coords: { enabled: boolean; x: number; y: number };
    template: { enabled: boolean; templateId?: string; templatePath?: string; threshold: number };
    yolo: { enabled: boolean; modelId?: string; modelPath?: string; classId?: string; label?: string; threshold: number };
    ocr: { enabled: boolean; text: string; engine?: OcrEngine; threshold: number };
    cloudApi: { enabled: boolean; profileId?: string; url?: string; apiKey?: string; prompt: string; threshold: number };
  };
  executionMode: 'cascade' | 'parallel';
  strategyOrder: ('coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi')[];
}>;

export type WorkflowNode = ClickNode | InputNode | WaitNode | ScreenshotNode | IfNode | LoopNode | RecognizeNode;

export type WorkflowEdge = {
  id: string;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
};

export type WorkflowDocument = {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

// ===== 模板库 =====

export type TemplateRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ClickOffset = {
  x: number;
  y: number;
};

export type TemplateFolder = {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TemplateDefinition = {
  id: string;
  name: string;
  notes?: string;
  app?: string;
  appZoom?: string;
  folderId?: string | null;
  tags?: string[];
  windowTitle?: string;
  matchHotspot?: TemplateRect;
  enabled?: boolean;
  resolution: { width: number; height: number };
  scaleFactor: number;
  clickOffset: ClickOffset;
  sourceRect: TemplateRect;
  imageFile: string;
  sourceFile?: string;
  createdAt: number;
  updatedAt: number;
};

export type TemplateCreatePayload = {
  name: string;
  notes?: string;
  app?: string;
  appZoom?: string;
  folderId?: string | null;
  tags?: string[];
  windowTitle?: string;
  matchHotspot?: TemplateRect;
  resolution: { width: number; height: number };
  scaleFactor: number;
  clickOffset: ClickOffset;
  sourceRect: TemplateRect;
  imageDataUrl: string;
  sourceDataUrl?: string;
};

export type TemplateUpdatePatch = Partial<Omit<TemplateCreatePayload, 'imageDataUrl'>> & {
  imageDataUrl?: string;
  enabled?: boolean;
};

export const defaultWorkflowDocument = (): WorkflowDocument => ({
  version: 1,
  nodes: [],
  edges: [],
});

export const createNodePorts = (type: WorkflowNode['type']): PortDefinition[] => {
  switch (type) {
    case 'click':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'input':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'wait':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'screenshot':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'if':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'true', label: 'True', direction: 'output', dataType: 'flow' },
        { id: 'false', label: 'False', direction: 'output', dataType: 'flow' },
      ];
    case 'loop':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'body', label: 'Body', direction: 'output', dataType: 'flow' },
        { id: 'done', label: 'Done', direction: 'output', dataType: 'flow' },
      ];
    case 'recognize':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    default:
      return [];
  }
};

// ===== YOLO 训练模块 =====

export type YoloClassDefinition = {
  id: string;
  name: string;
  color: string;
};

export type YoloBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type YoloAnnotation = {
  id: string;
  classId: string | null;
  box: YoloBox;
};

export type YoloImage = {
  id: string;
  fileName: string;
  file: string;
  width: number;
  height: number;
  createdAt: number;
};

export type YoloDataset = {
  id: string;
  name: string;
  notes?: string;
  imageCount: number;
  annotatedCount: number;
  classCount: number;
  createdAt: number;
  updatedAt: number;
};

export type YoloModelMetrics = {
  precision: number;
  recall: number;
  mAP50: number;
  mAP50_95: number;
};

export type YoloModelArtifacts = {
  confusionMatrix?: string;
  prCurve?: string;
};

export type YoloModel = {
  id: string;
  name: string;
  baseModel: string;
  datasetId: string;
  datasetName: string;
  epochs: number;
  imageSize: number;
  batch: number;
  file: string;
  sizeBytes: number;
  metrics: YoloModelMetrics | null;
  createdAt: number;
  isActive: boolean;
  /** 绝对路径（仅 list 时填充，供识别节点使用） */
  path?: string;
  /** 训练产物文件（相对 models/<id>/ 目录） */
  artifacts?: YoloModelArtifacts | null;
  /** 产物绝对路径（仅 list 时填充） */
  artifactPaths?: YoloModelArtifacts | null;
};

export type YoloAugmentConfig = {
  hsvH: number;
  hsvS: number;
  hsvV: number;
  degrees: number;
  translate: number;
  scale: number;
  shear: number;
  perspective: number;
  flipud: number;
  fliplr: number;
  mosaic: number;
  mixup: number;
  copyPaste: number;
  erasing: number;
  cropFraction: number;
};

export type YoloTrainConfig = {
  model: string;
  epochs: number;
  batch: number;
  imageSize: number;
  lr0: number;
  lrf: number;
  momentum: number;
  weightDecay: number;
  warmupEpochs: number;
  patience: number;
  device: string;
  workers: number;
  seed: number;
  deterministic: boolean;
  splitTrain: number;
  splitVal: number;
  augment: YoloAugmentConfig;
};

export type YoloEpochMetrics = {
  boxLoss: number;
  clsLoss: number;
  dflLoss: number;
  precision: number;
  recall: number;
  mAP50: number;
  mAP50_95: number;
};

export type YoloTrainingEvent =
  | { t: 'start'; jobId: string; totalEpochs: number; message?: string }
  | { t: 'epoch'; epoch: number; totalEpochs: number; lr: number; metrics: YoloEpochMetrics }
  | { t: 'progress'; epoch: number; percent: number; message: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error' | 'debug'; message: string }
  | { t: 'done'; modelPath: string; sizeBytes: number; metrics: YoloModelMetrics | null; artifacts?: YoloModelArtifacts }
  | { t: 'error'; message: string };

export type YoloEnvInfo = {
  pythonAvailable: boolean;
  pythonPath: string | null;
  pythonVersion: string | null;
  ultralytics: string | null;
  torch: string | null;
  cuda: boolean;
  mps: boolean;
  device: string;
};

export type YoloTrainingState = {
  running: boolean;
  jobId: string | null;
};

export const YOLO_CLASS_COLORS = [
  '#78a9ff', '#6ae3a1', '#f7c948', '#ff8f8f', '#c585ff',
  '#5ad5ff', '#ffb86b', '#ff6b9d', '#9fe870', '#8b9dc9',
  '#f0a0a0', '#a0d0f0', '#d0a0f0', '#f0d0a0', '#a0f0d0',
  '#f0a0d0', '#d0f0a0', '#a0d0d0', '#d0a0a0', '#a0a0f0',
];

export const createDefaultNode = (type: WorkflowNode['type'], index = 1): WorkflowNode => {
  const base = {
    id: `${type}-${Date.now()}-${index}`,
    type,
    title: type.toUpperCase(),
    position: { x: 100 + index * 20, y: 100 + index * 20 },
    enabled: true,
  } as const;

  switch (type) {
    case 'click':
      return {
        ...base,
        type,
        title: 'Click',
        data: { targetStrategy: 'coords', threshold: 60, x: 0, y: 0 },
      };
    case 'input':
      return {
        ...base,
        type,
        title: 'Input',
        data: { value: '', submit: false },
      };
    case 'wait':
      return {
        ...base,
        type,
        title: 'Wait',
        data: { mode: 'delay', delayMs: 1000 },
      };
    case 'screenshot':
      return {
        ...base,
        type,
        title: 'Screenshot',
        data: { regionMode: 'full' },
      };
    case 'if':
      return {
        ...base,
        type,
        title: 'If',
        data: { expression: 'true' },
      };
    case 'loop':
      return {
        ...base,
        type,
        title: 'Loop',
        data: { mode: 'count', count: 3 },
      };
    case 'recognize':
      return {
        ...base,
        type,
        title: 'Recognize',
        data: {
          strategies: {
            coords: { enabled: true, x: 0, y: 0 },
            template: { enabled: false, threshold: 60 },
            yolo: { enabled: false, threshold: 60 },
            ocr: { enabled: false, text: '', engine: 'auto', threshold: 60 },
            cloudApi: { enabled: false, prompt: '', threshold: 60 },
          },
          executionMode: 'cascade',
          strategyOrder: ['coords', 'template', 'yolo', 'ocr', 'cloudApi'],
        },
      };
  }
};