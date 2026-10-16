import type { LegacyFrameRateSetting, StreamFrameRate } from './frameRate';
import type { WorkflowStateValue } from './workflowState';

export type NodeType =
  | 'liveVision'
  | 'click'
  | 'wait'
  | 'screenshot'
  | 'if'
  | 'loop'
  | 'recognize'
  | 'scroll'
  | 'keyboard'
  | 'gamepad'
  | 'spatialDetector'
  | 'state'
  | 'movePlayer';

export * from './frameRate';
export * from './workflowState';
export * from './movementControl';
export * from './workflowGraph';
export * from './spatialOverlay';
export * from './spatialGeometry';

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

export type ConditionType =
  | 'lastOk'            // 上一次节点（检查前面连线的节点）
  | 'nodeCheck'         // 指定节点（通过标题选择）
  | 'spatialArrived'    // 最近一次 Spatial Detector 已到达目标
  | 'spatialNotArrived' // 最近一次 Spatial Detector 尚未到达目标
  | 'custom';           // 自定义表达式

/** If 只判断直接前一个节点是否成功；旧条件字段仅为历史数据兼容，不再参与分支。 */
export type IfNode = WorkflowNodeBase<'if', {
  /** @deprecated If 现在固定判断直接前一个节点的成功/失败。 */
  conditionType?: ConditionType;
  /** @deprecated If 现在固定判断直接前一个节点的成功/失败。 */
  expression: string;
  /** @deprecated */
  targetNodeId?: string;
  /** @deprecated */
  targetNodeTitle?: string;
}>;

export type LoopNode = WorkflowNodeBase<'loop', {
  /** untilBreak：循环体回边作为 Continue，进入 Loop Down 作为 Break。 */
  mode: 'count' | 'condition' | 'untilBreak';
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
  /** 按键发送目标：系统全局 / 指定串流窗口 */
  target?: 'global' | 'stream';
  /** target=stream 时：串流设备 id */
  streamSourceId?: string;
  /** target=stream 时：窗口标题关键字 */
  streamWindowHint?: string;
}>;


export type GamepadAction =
  | 'pressCross' | 'pressCircle' | 'pressTriangle' | 'pressSquare'
  | 'pressL1' | 'pressR1' | 'pressL2' | 'pressR2'
  | 'pressOptions' | 'pressShare' | 'pressPS'
  | 'pressDPADL' | 'pressDPADR' | 'pressDPADU' | 'pressDPADD'
  | 'pressLU' | 'pressLD' | 'pressLL' | 'pressLR'
  | 'pressRU' | 'pressRD' | 'pressRL' | 'pressRR'
  /** @deprecated 仅用于兼容旧工作流，新节点和界面统一使用 1/2/3/4 PS5 动作 */
  | 'pressA' | 'pressB' | 'pressX' | 'pressY'
  | 'pressRT' | 'pressLT' | 'pressRB' | 'pressLB'
  | 'pressSTART' | 'pressBACK' | 'pressHOME';

export type GamepadNode = WorkflowNodeBase<'gamepad', {
  action: GamepadAction;
  /** 游戏内自定义键盘按键；设置后优先于默认手柄/键盘映射 */
  keyboardKey?: string;
  /** 按键发送目标：系统全局 / 串流设备配置的窗口 */
  target: 'global' | 'stream';
  /** target=stream 时：串流设备 id，目标窗口由该设备配置决定 */
  streamSourceId?: string;
  /** @deprecated 旧工作流兼容字段；Gamepad 现在只使用串流设备配置的窗口 */
  streamWindowHint?: string;
  /** 按键持续时间（毫秒），0表示瞬间按下 */
  durationMs?: number;
  /** 按键后延迟（毫秒） */
  delayMs?: number;
  /** 是否使用CDP协议发送按键 */
  useCdp?: boolean;
  /** CDP调试端口 */
  cdpPort?: number;
  /** 是否使用SharedMemoryGamepad发送按键 */
  useSharedMemory?: boolean;
}>;

export type Point2D = {
  x: number;
  y: number;
};

/** 图像点与真实世界平面点的四点（或更多点）对应关系。 */
export type WorldCalibration = {
  image: Point2D[];
  world: Point2D[];
  /** 世界坐标单位，例如 px、cm、m。 */
  unit?: string;
};

export type YoloKeypoint = {
  id?: string;
  label?: string;
  x: number;
  y: number;
  confidence?: number;
};

/**
 * 通用空间检测节点：识别 player 与 target，并计算它们在图像坐标或标定后的世界坐标中的关系。
 * 不绑定任何具体场景，篮球三分线只是 target 的一种使用方式。
 */
export type SpatialDetectorNode = WorkflowNodeBase<'spatialDetector', {
  modelId?: string;
  modelPath?: string;
  numClasses?: number;
  /** live：节点内部持续获取新画面；frame：只分析前面 Screenshot 留下的当前帧 */
  captureMode: 'live' | 'frame';
  source: 'screen' | 'window' | 'stream';
  streamSourceId?: string;
  windowHint?: string;
  windowId?: number;
  windowApp?: string;
  fps: LegacyFrameRateSetting;
  timeoutMs: number;
  playerLabel: string;
  targetLabel: string;
  threshold: number;
  playerAnchor: 'boxCenter' | 'keypoint';
  targetAnchor: 'boxDistance' | 'boxCenter' | 'nearestBoxPoint' | 'keypoint';
  playerKeypoint?: string;
  targetKeypoint?: string;
  /** targetAnchor=boxDistance 时使用的目标边；nearest 表示四边中的最短距离。 */
  targetEdge?: SpatialTargetEdge;
  /** detection：Target 也由 YOLO 识别；polyline：Target 是手工/标定得到的三分线等折线。 */
  targetMode?: SpatialTargetMode;
  /** targetMode=polyline 时至少两个图像坐标点。 */
  targetPolyline?: Point2D[];
  calibration?: WorldCalibration;
  arrivalTolerance: number;
  stabilityFrames: number;
}>;

export type WorkflowStateNode = WorkflowNodeBase<'state', {
  /** branch：双输出判断当前状态；switch：在 Loop Down 前切换状态。 */
  mode: 'branch' | 'switch';
  stateALabel: string;
  stateBLabel: string;
  switchTo: 'toggle' | 'stateA' | 'stateB';
}>;

export type MoveDirection = 'up' | 'down' | 'left' | 'right' | 'stop';
export type SpatialTargetMode = 'detection' | 'polyline';
export type SpatialTargetEdge = 'nearest' | 'top' | 'bottom' | 'left' | 'right';
export type MoveControl = 'gamepad' | 'gamepadAnalog' | 'keyboard';
export type MovePlayerControlMode = 'continuous' | 'pulse';

/**
 * 通用移动节点：可由 Spatial Detector 的方向自动选择动作，也可手动指定方向。
 * gamepadAnalog 面向 PS5 Direct Remote Play，通过左摇杆输出连续向量。
 */
export type MovePlayerNode = WorkflowNodeBase<'movePlayer', {
  /** continuous：逐帧检测并持续保持输入；pulse：兼容旧行为的单次按压。 */
  controlMode?: MovePlayerControlMode;
  /** continuous 自动方向使用的 Spatial Detector；留空时使用流程中最近的一个。 */
  detectorNodeId?: string;
  directionMode: 'auto' | 'manual';
  direction: MoveDirection;
  control: MoveControl;
  target: 'global' | 'stream';
  streamSourceId?: string;
  keyboardUp?: string;
  keyboardDown?: string;
  keyboardLeft?: string;
  keyboardRight?: string;
  /** gamepadAnalog 使用的摇杆。 */
  stick?: 'left' | 'right';
  /** 摇杆最大/最小模拟量，距离越近输出越小，形成接近-刹车。 */
  maxStickMagnitude?: number;
  minStickMagnitude?: number;
  /** 小于等于该距离立即释放输入，单位与 Spatial Detector 的距离单位一致。 */
  deadZone?: number;
  /** 从最大速度开始线性降速的距离。 */
  brakeDistance?: number;
  /** pulse 模式的单次按压时长。 */
  durationMs: number;
  delayMs: number;
  /** stable arrival 或进入停止距离时释放输入。 */
  stopWhenArrived: boolean;
  /** 释放输入后结束 Move Player，并继续执行后续节点；关闭时保持持续监测。 */
  exitOnArrival?: boolean;
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
  /** 置信度 0-100 */
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

export type StreamTransport = 'externalWindow' | 'ps5Direct';

export type Ps5StreamResolution = '360p' | '540p' | '720p' | '1080p';

export type Ps5AccountProfile = {
  id: string;
  name: string;
  onlineId: string;
  /** 8 字节 Account ID 的 Base64 表示 */
  accountId: string;
  accountIdSource: 'manual' | 'lookup';
  createdAt: number;
  updatedAt: number;
};

export type Ps5HostInfo = {
  host: string;
  hostId?: string;
  hostType?: string;
  name?: string;
  status?: string;
  macAddress?: string;
  systemVersion?: string;
};

export type Ps5HostTestResult = {
  host: string;
  status: string;
  online: boolean;
  latencyMs: number;
};

export type Ps5RuntimeStatus = {
  version: string;
  fake: boolean;
  connected: boolean;
  host?: string | null;
  accountId?: string | null;
  state: string;
  ready: boolean;
  frameCount: number;
};

export type Ps5Frame = {
  frame: string;
  width: number;
  height: number;
  timestamp: number;
};

export type StreamSourceProfile = {
  id: string;
  name: string;
  type: StreamSourceType;
  /** PS5 使用内置协议会话，或继续匹配外部串流窗口 */
  transport?: StreamTransport;
  /** transport=ps5Direct 时绑定的 PS5 账号 */
  ps5AccountId?: string;
  ps5Resolution?: Ps5StreamResolution;
  /** 采集来源的目标帧率。 */
  captureFps?: StreamFrameRate;
  /** @deprecated 兼容旧 PS5 配置，新配置使用 captureFps。 */
  ps5Fps?: StreamFrameRate;
  /** 主机地址（IP / 主机名），用于连通性测试 */
  host?: string;
  /** 测试端口 */
  port?: number;
  /** 通用 URL（如 http/rtsp 流地址） */
  url?: string;
  /** 串流窗口标题关键字，用于画面探测时自动预选 */
  windowHint?: string;
  /** 已绑定的精确 CGWindowID，标题变化时仍优先定位同一窗口 */
  windowId?: number;
  /** 已绑定窗口所属应用名，窗口 ID 失效时兜底 */
  windowApp?: string;
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
    ocr: { enabled: boolean; text: string; engine?: OcrEngine; lang?: 'auto' | 'eng' | 'chi_sim'; threshold: number };
    cloudApi: { enabled: boolean; profileId?: string; apiIds?: string[]; apiMode?: 'cascade' | 'parallel'; url?: string; apiKey?: string; prompt: string; threshold: number };
  };
  executionMode: 'cascade' | 'parallel';
  strategyOrder: ('coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi')[];
}>;

export type LiveVisionNode = WorkflowNodeBase<'liveVision', {
  /** 画面来源 */
  source: 'screen' | 'window' | 'stream';
  streamSourceId?: string;
  windowHint?: string;
  windowId?: number;
  windowApp?: string;
  /** 处理帧率：跟随来源，或固定 30/60 FPS */
  fps: LegacyFrameRateSetting;
  /** 检测超时毫秒 */
  timeoutMs: number;
  /** 检测方式 */
  detectMode: 'yolo' | 'template' | 'ocr' | 'both' | 'all';
  /** 检测到目标后的动作 */
  action: 'returnCoords' | 'click';
  yoloModelPath?: string;
  yoloLabel?: string;
  yoloThreshold?: number;
  templatePath?: string;
  templateThreshold?: number;
  ocrText?: string;
  ocrEngine?: OcrEngine;
  ocrLang?: 'auto' | 'eng' | 'chi_sim';
  ocrThreshold?: number;
}>;

export type WorkflowNode =
  | ClickNode
  | WaitNode
  | ScreenshotNode
  | IfNode
  | LoopNode
  | RecognizeNode
  | ScrollNode
  | KeyboardNode
  | LiveVisionNode
  | GamepadNode
  | SpatialDetectorNode
  | WorkflowStateNode
  | MovePlayerNode;

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

export type TemplateLibraryStats = {
  indexedCount: number;
  detectedCount: number;
  libraryCount: number;
  unclassifiedCount: number;
  missingCount: number;
  detectedAt: number;
};

export type TemplateLibraryListResult = {
  folders: TemplateFolder[];
  templates: TemplateDefinition[];
  stats: TemplateLibraryStats;
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
  /** Chiaki-ng 可执行文件路径，未找到为 null */
  chiakiPath: string | null;
  /** SharedMemory 是否可用 */
  sharedMemoryAvailable: boolean;
  cuda: boolean;
  mps: boolean;
  device: string;
  /** Python 依赖版本；旧运行时未返回该字段时为 undefined */
  pythonPackages?: Record<string, string | null>;
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
  /** 关键点模型返回的可选关键点；检测模型通常没有该字段。 */
  keypoints?: YoloKeypoint[];
};

export type YoloDetectResult = {
  ok: boolean;
  detections?: YoloDetection[];
  message?: string;
};

export type VisionOverlayBox = {
  kind: 'box';
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  confidence?: number;
  color?: string;
};

export type VisionOverlayPoint = {
  kind: 'point';
  x: number;
  y: number;
  label?: string;
  confidence?: number;
  color?: string;
};

export type VisionOverlayMarker = VisionOverlayBox | VisionOverlayPoint;

export type VisionOverlaySourceKind = 'ps5Direct' | 'other';

/** 识别结果始终使用识别时的原始画面坐标；显示层负责随画面尺寸等比换算。 */
export type VisionOverlayPayload = {
  sourceWidth: number;
  sourceHeight: number;
  sourceKind?: VisionOverlaySourceKind;
  streamSourceId?: string;
  markers: VisionOverlayMarker[];
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
  /** YOLO 返回的全部检测框；selected 命中仍保留在 detections 中。 */
  detections?: YoloDetection[];
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
  /** 可直接叠加到对应串流画面的识别框/点，坐标基于 width/height。 */
  visionOverlay?: VisionOverlayPayload;
  /** loop 节点实际迭代次数 */
  loopCount?: number;
  /** if 节点走的分支 */
  branch?: 'true' | 'false';
  /** 命中使用的策略 key */
  strategy?: RecognizeStrategyKey;
  /** 调试图路径（仅用于模板等策略的可视化调试） */
  debugImagePath?: string;
  /** liveVision 运行态指标：每秒帧数 */
  liveFps?: number;
  /** 配置的处理帧率上限。 */
  targetFps?: StreamFrameRate;
  /** 实际完成的处理帧率。 */
  processingFps?: number;
  /** 实际完成的处理帧数。 */
  processingFrameCount?: number;
  /** liveVision 运行态指标：累计帧数 */
  liveFrameCount?: number;
  /** liveVision 运行态指标：命中次数 */
  liveHitCount?: number;
  /** liveVision 运行态指标：命中率 0-1 */
  liveHitRate?: number;
  /** liveVision 运行态指标：最近一次命中 */
  liveLatestHit?: { x: number; y: number; label?: string; confidence?: number };
  /** 通用空间检测结果：图像坐标、可选世界坐标、距离、方向和到点状态。 */
  spatial?: SpatialResult;
  /** Player/Target 已分别缓存，但尚未同时计算空间关系。 */
  partial?: boolean;
  /** 本帧更新了至少一个 Player/Target 观察，可用于重置无进展超时。 */
  spatialProgress?: boolean;
  /** Player/Target 均已观察到，空间关系可用。 */
  spatialReady?: boolean;
  /** Move Player 实际选择的移动方向。 */
  moveDirection?: MoveDirection;
  /** State 判断或切换后的状态值。 */
  stateValue?: WorkflowStateValue;
  /** gamepadAnalog 实际输出的摇杆向量。 */
  moveVector?: Point2D;
  moveMagnitude?: number;
  /** Spatial Detector 已将直连 Move Player 纳入同一持续闭环。 */
  moveIntegrated?: boolean;
};

export type SpatialResult = {
  player: { image: Point2D; world?: Point2D };
  target: { image: Point2D; world?: Point2D };
  distance: number;
  distanceSpace: 'image' | 'world';
  /** 图像坐标系中的归一化移动方向。 */
  direction: Point2D;
  /** 根据距离和刹车参数计算出的推荐移动向量。 */
  movement: Point2D;
  requiredStickMagnitude: number;
  targetMode: SpatialTargetMode;
  arrived: boolean;
  stableFrames: number;
  calibrationApplied: boolean;
  playerBox?: [number, number, number, number];
  targetBox?: [number, number, number, number];
};

/** 用四对图像/世界平面点求 3×3 单应矩阵，返回 [h0...h7]，h8 固定为 1。 */
export function solveHomography(image: Point2D[], world: Point2D[]): number[] | null {
  if (image.length < 4 || world.length < 4) return null;
  const rows: number[][] = [];
  const values: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = image[i];
    const { x: u, y: v } = world[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }

  // Gaussian elimination with partial pivoting. Calibration points are user-entered,
  // so reject singular/degenerate layouts instead of silently producing bad world coordinates.
  const n = 8;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      [rows[pivot], rows[col]] = [rows[col], rows[pivot]];
      [values[pivot], values[col]] = [values[col], values[pivot]];
    }
    const divisor = rows[col][col];
    for (let j = col; j < n; j += 1) rows[col][j] /= divisor;
    values[col] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = col; j < n; j += 1) rows[row][j] -= factor * rows[col][j];
      values[row] -= factor * values[col];
    }
  }
  return values;
}

export function transformPointWithHomography(point: Point2D, h: number[]): Point2D | null {
  if (h.length !== 8) return null;
  const denominator = h[6] * point.x + h[7] * point.y + 1;
  if (Math.abs(denominator) < 1e-9) return null;
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / denominator,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / denominator,
  };
}

export function normalizeVector(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

export type WorkflowRunEvent =
  | { t: 'start'; runId: string; nodeCount: number; message?: string }
  | { t: 'nodeStart'; runId: string; nodeId: string; step?: number; totalSteps?: number }
  | { t: 'nodeEnd'; runId: string; nodeId: string; result: NodeRunResult }
  | { t: 'visionOverlay'; runId: string; nodeId: string; overlay: VisionOverlayPayload }
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
  /** 用于确认运行进程确实加载了并行执行器，避免旧 Electron 主进程静默运行。 */
  executorVersion?: string;
};

export const defaultWorkflowDocument = (): WorkflowDocument => ({
  version: 1,
  nodes: [],
  edges: [],
});

export const createNodePorts = (type: WorkflowNode['type'], loopRole?: 'begin' | 'down'): PortDefinition[] => {
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
      return loopRole === 'down'
        ? [
            { id: 'in', label: '循环体', direction: 'input', dataType: 'flow' },
            { id: 'again', label: '回环', direction: 'output', dataType: 'flow' },
            { id: 'next', label: '顺序', direction: 'output', dataType: 'flow' },
          ]
        : [
            { id: 'in', label: '顺序入口', direction: 'input', dataType: 'flow' },
            { id: 'again', label: '回环入口', direction: 'input', dataType: 'flow' },
            { id: 'body', label: '循环体', direction: 'output', dataType: 'flow' },
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
    case 'gamepad':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'spatialDetector':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'state':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'true', label: '状态 A', direction: 'output', dataType: 'flow' },
        { id: 'false', label: '状态 B', direction: 'output', dataType: 'flow' },
      ];
    case 'movePlayer':
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

export * from './spatialTracking';

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

export type YoloPythonDependencySpec = {
  key: string;
  label: string;
  /** 传给 pip 的 requirement，可包含版本约束 */
  packageName: string;
  /** 用于检测安装状态的 Python 模块名 */
  importName: string;
  /** 用于读取版本号的 pip distribution 名称 */
  distributionName: string;
  usedBy: string;
  hint: string;
};

/** YOLOX requirements.txt 中需要在“全局环境依赖”里独立检测和安装的 Python 包 */
export const YOLOX_PYTHON_DEPENDENCIES: YoloPythonDependencySpec[] = [
  {
    key: 'loguru',
    label: 'Loguru',
    packageName: 'loguru',
    importName: 'loguru',
    distributionName: 'loguru',
    usedBy: 'YOLOX 训练日志',
    hint: 'Loguru 负责 YOLOX 训练过程日志。缺少它时导入 yolox.core.trainer 会直接失败。',
  },
  {
    key: 'tqdm',
    label: 'tqdm',
    packageName: 'tqdm',
    importName: 'tqdm',
    distributionName: 'tqdm',
    usedBy: 'YOLOX 数据加载与验证进度',
    hint: 'tqdm 提供数据集加载和评估时的进度显示，是 YOLOX 数据模块的运行依赖。',
  },
  {
    key: 'thop',
    label: 'THOP',
    packageName: 'thop',
    importName: 'thop',
    distributionName: 'thop',
    usedBy: 'YOLOX 模型统计',
    hint: 'THOP 用于统计模型参数量和计算量，YOLOX 打印模型摘要时需要它。',
  },
  {
    key: 'ninja',
    label: 'Ninja',
    packageName: 'ninja',
    importName: 'ninja',
    distributionName: 'ninja',
    usedBy: 'YOLOX JIT 编译',
    hint: 'Ninja 是 PyTorch JIT 运算编译所需的构建工具，部分 YOLOX 加速层会使用。',
  },
  {
    key: 'tabulate',
    label: 'tabulate',
    packageName: 'tabulate',
    importName: 'tabulate',
    distributionName: 'tabulate',
    usedBy: 'YOLOX 评估结果表格',
    hint: 'tabulate 用于格式化验证指标表格，是 YOLOX 评估器的运行依赖。',
  },
  {
    key: 'psutil',
    label: 'psutil',
    packageName: 'psutil',
    importName: 'psutil',
    distributionName: 'psutil',
    usedBy: 'YOLOX 资源监控',
    hint: 'psutil 用于读取内存、CPU 等运行资源信息，帮助显示训练资源占用。',
  },
  {
    key: 'tensorboard',
    label: 'TensorBoard',
    packageName: 'tensorboard',
    importName: 'tensorboard',
    distributionName: 'tensorboard',
    usedBy: 'YOLOX 训练曲线记录',
    hint: 'TensorBoard 被 YOLOX Trainer 用来记录训练曲线；缺少它时训练器无法导入。',
  },
  {
    key: 'pycocotools',
    label: 'pycocotools',
    packageName: 'pycocotools>=2.0.2',
    importName: 'pycocotools',
    distributionName: 'pycocotools',
    usedBy: 'YOLOX COCO 数据集与评估',
    hint: 'pycocotools 负责读取 COCO 标注并计算 mAP，是 YOLOX 数据集和验证流程的核心依赖。',
  },
  {
    key: 'onnx',
    label: 'ONNX',
    packageName: 'onnx>=1.13.0',
    importName: 'onnx',
    distributionName: 'onnx',
    usedBy: 'YOLOX 模型导出',
    hint: 'ONNX 用于把训练好的模型导出为通用推理格式，不影响训练但会影响模型导出。',
  },
  {
    key: 'onnxsim',
    label: 'onnx-simplifier',
    packageName: 'onnx-simplifier==0.4.10',
    importName: 'onnxsim',
    distributionName: 'onnx-simplifier',
    usedBy: 'YOLOX ONNX 模型优化',
    hint: 'onnx-simplifier 用于简化导出的 ONNX 图，减少冗余算子并提高部署兼容性。',
  },
];

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
  /** YOLOX Python 依赖版本；未安装为 null */
  packages: Record<string, string | null>;
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
        data: { keys: 'a', mode: 'tap', interval: 200, target: 'global' },
      };
    case 'gamepad':
      return {
        ...base,
        type,
        title: 'Gamepad',
        data: { action: 'pressCross', target: 'stream', durationMs: 120, delayMs: 100 },
      };
    case 'liveVision':
      return {
        ...base,
        type,
        title: 'Live Vision',
        data: { source: 'stream', fps: 'source', timeoutMs: 5000, detectMode: 'yolo', action: 'returnCoords', yoloThreshold: 60, templateThreshold: 60 },
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
    case 'spatialDetector':
      return {
        ...base,
        type,
        title: 'Spatial Detector',
        data: {
          captureMode: 'live',
          source: 'stream',
          fps: 'source',
          timeoutMs: 5000,
          numClasses: 2,
          playerLabel: 'player',
          targetLabel: 'target',
          targetMode: 'detection',
          targetPolyline: [],
          targetEdge: 'nearest',
          threshold: 60,
          playerAnchor: 'boxCenter',
          targetAnchor: 'boxDistance',
          arrivalTolerance: 5,
          stabilityFrames: 3,
        },
      };
    case 'state':
      return {
        ...base,
        type,
        title: 'State',
        data: {
          mode: 'branch',
          stateALabel: '进攻',
          stateBLabel: '防守',
          switchTo: 'toggle',
        },
      };
    case 'movePlayer':
      return {
        ...base,
        type,
        title: 'Move Player',
        data: {
          controlMode: 'continuous',
          directionMode: 'auto',
          direction: 'stop',
          control: 'gamepadAnalog',
          stick: 'left',
          maxStickMagnitude: 0.7,
          minStickMagnitude: 0.2,
          deadZone: 10,
          brakeDistance: 120,
          target: 'stream',
          durationMs: 120,
          delayMs: 80,
          stopWhenArrived: true,
          exitOnArrival: true,
          keyboardUp: 'w',
          keyboardDown: 's',
          keyboardLeft: 'a',
          keyboardRight: 'd',
        },
      };
  }
};
