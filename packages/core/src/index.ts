export type NodeType =
  | 'click'
  | 'wait'
  | 'screenshot'
  | 'if'
  | 'loop'
  | 'recognize'
  | 'scroll'
  | 'keyboard';

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



export type WaitNode = WorkflowNodeBase<'wait', {
  mode: 'delay' | 'condition';
  delayMs?: number;
  conditionText?: string;
}>;

export type ScreenshotNode = WorkflowNodeBase<'screenshot', {
  regionMode: 'full' | 'selected';
  /** 画面来源：系统屏幕 / 本机指定窗口 / 配置的串流设备窗口 */
  source: 'screen' | 'window' | 'stream';
  /** source=stream 时：串流设备 id */
  streamSourceId?: string;
  /** source=window 时：窗口标题关键字，用于匹配本机窗口 */
  windowHint?: string;
  /** source=window 时：锁定的 CGWindowID（标题变化也能精确定位） */
  windowId?: number;
  /** source=window 时：锁定的应用进程名（如 Google Chrome），ID 失效时兜底 */
  windowApp?: string;
  region?: TemplateRect;
}>;

export type IfNode = WorkflowNodeBase<'if', {
  expression: string;
}>;

export type LoopNode = WorkflowNodeBase<'loop', {
  mode: 'count' | 'condition';
  count?: number;
  conditionText?: string;
  role?: 'begin' | 'down';
  pairId?: string;
}>;

export type ScrollPreset = 'small' | 'medium' | 'large' | 'custom';

export type ScrollNode = WorkflowNodeBase<'scroll', {
  direction: 'up' | 'down' | 'left' | 'right';
  preset: ScrollPreset;
  customAmount?: number;
}>;

export type KeyboardNode = WorkflowNodeBase<'keyboard', {
  keys: string;
  mode: 'tap' | 'hold' | 'type';
  /** 连续输入时每个字符之间的间隔（毫秒） */
  interval?: number;
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

// ===== 串流设备管理 =====

export type StreamSourceType = 'ps5' | 'xbox' | 'secondPc' | 'local' | 'otherDevice';

export type StreamSourceProfile = {
  id: string;
  name: string;
  type: StreamSourceType;
  /** 主机地址（IP / 主机名），用于连通性测试 */
  host?: string;
  /** 测试端口 */
  port?: number;
  /** 通用 URL（如 http/rtsp 流地址） */
  url?: string;
  /** 串流窗口标题关键字，用于画面探测时自动预选 */
  windowHint?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
  lastTestAt?: number | null;
  lastTestStatus?: 'ok' | 'error' | null;
  lastTestMessage?: string | null;
};

export type StreamWindowInfo = {
  /** desktopCapturer 的 source id，用于抓帧 */
  id: string;
  /** 窗口标题 */
  name: string;
  /** 缩略图 dataURL */
  thumbnail: string;
  /** 窗口缩略图宽高 */
  width: number;
  height: number;
  /** 从 source id 解析出的数值 CGWindowID（标题变化也稳定） */
  windowId?: number;
  /** 所属应用进程名（如 Google Chrome） */
  windowApp?: string;
};

export type StreamScreenshotResult = {
  ok: boolean;
  frame?: string;
  width?: number;
  height?: number;
  message?: string;
};

export type StreamProbeResult = {
  ok: boolean;
  message?: string;
  windows: StreamWindowInfo[];
};

export type StreamConnectionTestResult = {
  ok: boolean;
  message?: string;
  latencyMs?: number | null;
  lastTestAt: number;
};

export type StreamMotionResult = {
  ok: boolean;
  /** 两帧画面是否有明显变化（判定画面在动） */
  changed: boolean;
  /** 差异比例 0-1 */
  diffRatio: number;
  /** 最新一帧 dataURL，用于预览 */
  frame?: string;
  width?: number;
  height?: number;
  message?: string;
};

export type RecognizeNode = WorkflowNodeBase<'recognize', {
  strategies: {
    coords: { enabled: boolean; x: number; y: number };
    template: { enabled: boolean; templateId?: string; templatePath?: string; threshold: number };
    yolo: { enabled: boolean; modelId?: string; modelPath?: string; classId?: string; label?: string; threshold: number };
    ocr: { enabled: boolean; text: string; engine?: OcrEngine; threshold: number };
    cloudApi: { enabled: boolean; profileId?: string; apiIds?: string[]; apiMode?: 'cascade' | 'parallel'; url?: string; apiKey?: string; prompt: string; threshold: number };
  };
  executionMode: 'cascade' | 'parallel';
  strategyOrder: ('coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi')[];
}>;

export type WorkflowNode = ClickNode | WaitNode | ScreenshotNode | IfNode | LoopNode | RecognizeNode | ScrollNode | KeyboardNode;

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

// ===== 视觉运行时（识别测试台 / 执行引擎） =====

export type EngineEnvInfo = {
  /** OpenCV 版本号，未安装为 null */
  cv2: string | null;
  /** PyTorch 版本号，未安装为 null */
  torch: string | null;
  /** YOLOX 版本号，未安装为 null */
  yolox: string | null;
  /** pyautogui 版本号，未安装为 null */
  pyautogui: string | null;
  /** PaddleOCR 版本号，未安装为 null */
  paddleocr: string | null;
  cuda: boolean;
  mps: boolean;
  device: string;
};

export type TemplateMatchResult = {
  ok: boolean;
  /** 模板左上角在图片中的坐标 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** 匹配置信度 0-100 */
  confidence?: number;
  /** 按模板热点/点击偏移计算出的实际点击坐标 */
  clickX?: number;
  clickY?: number;
  message?: string;
};

export type YoloDetection = {
  label: string;
  /** 置信度 0-100 */
  confidence: number;
  /** [x, y, width, height] */
  box: [number, number, number, number];
};

export type YoloDetectResult = {
  ok: boolean;
  detections?: YoloDetection[];
  message?: string;
};

export type CloudApiVisionResult = {
  ok: boolean;
  x?: number;
  y?: number;
  /** 服务端原始响应（截断） */
  raw?: string;
  message?: string;
};

export type EngineRunResult = {
  ok: boolean;
  message?: string;
  [key: string]: unknown;
};


// ===== 工作流执行引擎 =====

export type WorkflowRunStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'done' | 'error';

export type NodeRunStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skipped';

export type RecognizeStrategyKey = 'coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi';

export type RecognizeStrategyRun = {
  key: RecognizeStrategyKey;
  status: 'hit' | 'miss' | 'error' | 'skipped';
  confidence?: number;
  message?: string;
  x?: number;
  y?: number;
  matchBox?: { x: number; y: number; width: number; height: number };
  matchScale?: number;
  elapsedMs?: number;
  debugImagePath?: string;
};

export type NodeRunResult = {
  nodeId: string;
  status: NodeRunStatus;
  elapsedMs?: number;
  message?: string;
  /** 识别结果在截图像素坐标中的位置 */
  hitCoords?: { x: number; y: number };
  /** 模板匹配框在截图像素坐标中的位置 */
  matchBox?: { x: number; y: number; width: number; height: number };
  /** 模板相对于原模板图的匹配缩放倍率 */
  matchScale?: number;
  /** click 节点实际发送给系统的屏幕坐标，仅用于诊断 */
  actualClickCoords?: { x: number; y: number };
  /** recognize 各策略执行明细 */
  strategies?: RecognizeStrategyRun[];
  /** screenshot 节点捕获的画面 dataURL */
  frame?: string;
  /** screenshot 截图宽度（缩略图像素） */
  width?: number;
  /** screenshot 截图高度（缩略图像素） */
  height?: number;
  /** loop 节点实际迭代次数 */
  loopCount?: number;
  /** if 节点走的分支 */
  branch?: 'true' | 'false';
  /** 命中使用的策略 key */
  strategy?: RecognizeStrategyKey;
  /** 调试图路径（仅用于模板等策略的可视化调试） */
  debugImagePath?: string;
};

export type WorkflowRunEvent =
  | { t: 'start'; runId: string; nodeCount: number; message?: string }
  | { t: 'nodeStart'; runId: string; nodeId: string; step?: number; totalSteps?: number }
  | { t: 'nodeEnd'; runId: string; nodeId: string; result: NodeRunResult }
  | { t: 'log'; runId: string; level: 'info' | 'warn' | 'error' | 'debug'; message: string; nodeId?: string }
  | { t: 'pause'; runId: string; nodeId?: string; message?: string }
  | { t: 'resume'; runId: string }
  | { t: 'stopped'; runId: string; message?: string }
  | {
      t: 'done';
      runId: string;
      summary: { ok: boolean; nodeCount: number; failedNodeIds: string[]; durationMs: number; message?: string };
    };

export type WorkflowRunSnapshot = {
  runId: string | null;
  status: WorkflowRunStatus;
  startedAt: number | null;
  nodeStates: Record<string, NodeRunStatus>;
  nodeResults: Record<string, NodeRunResult>;
};

export type WorkflowRunHandle = {
  started: boolean;
  message?: string;
  runId?: string;
  runMode?: 'local' | 'stream';
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
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'recognize':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'scroll':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'keyboard':
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
  /** 训练时的类别数（导出 / 推理时重建模型结构需要） */
  numClasses?: number;
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
  | { t: 'error'; message: string }
  /** pip 安装的下载进度（yolo:packageOutput 通道） */
  | { t: 'packageProgress'; percent: number; doneMb: number; totalMb: number; speed: string; eta: string };

export type YoloEnvInfo = {
  pythonAvailable: boolean;
  pythonPath: string | null;
  pythonVersion: string | null;
  /** pip 版本号，未安装为 null */
  pip: string | null;
  yolox: string | null;
  /** 当前配置的 YOLOX 源码目录（绝对路径） */
  yoloxPath: string | null;
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

/** pip 镜像源选项；value 为空字符串表示官方源（不加 -i 参数） */
export const PIP_MIRROR_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '官方源 pypi.org' },
  { value: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华 TUNA' },
  { value: 'https://mirrors.aliyun.com/pypi/simple', label: '阿里云' },
  { value: 'https://pypi.mirrors.ustc.edu.cn/simple', label: '中科大 USTC' },
  { value: 'https://mirrors.cloud.tencent.com/pypi/simple', label: '腾讯云' },
];

/** GitHub Releases 下载加速前缀；value 为空字符串表示直连 GitHub */
export const GITHUB_PROXY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '直连 GitHub' },
  { value: 'https://gh-proxy.com/', label: 'gh-proxy.com' },
  { value: 'https://ghfast.top/', label: 'ghfast.top' },
  { value: 'https://gh-proxy.net/', label: 'gh-proxy.net' },
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
        data: { regionMode: 'full', source: 'screen' },
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
        title: 'Loop Begin',
        data: { mode: 'count', count: 3, role: 'begin', pairId: `${base.id}-pair` },
      };
    case 'scroll':
      return {
        ...base,
        type,
        title: 'Scroll',
        data: { preset: 'medium', customAmount: 300, direction: 'down' },
      };
    case 'keyboard':
      return {
        ...base,
        type,
        title: 'Keyboard',
        data: { keys: 'a', mode: 'tap', interval: 200 },
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
            cloudApi: { enabled: false, prompt: '', threshold: 60, apiMode: 'cascade' },
          },
          executionMode: 'cascade',
          strategyOrder: ['coords', 'template', 'yolo', 'ocr', 'cloudApi'],
        },
      };
  }
};