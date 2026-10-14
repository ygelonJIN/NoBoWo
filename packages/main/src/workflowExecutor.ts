import { app, desktopCapturer, screen } from 'electron';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  buildSpatialOverlayMarkers,
  calculateSpatialMovement,
  closestPointOnBox,
  closestPointOnPolyline,
  closestPointsBetweenBoxes,
  CONTINUOUS_MOVE_FPS,
  createPartialSpatialResult,
  decideContinuousMoveFrame,
  directionFromVector,
  normalizeVector,
  updateGameplayStateTracker,
  resolveFrameRateSetting,
  solveHomography,
  summarizeSpatialObservations,
  transformPointWithHomography,
  updateSpatialObservations,
} from '@nobowo/core';
import type {
  CloudApiProfile,
  GameplayStateNode,
  GameplayStateTracker,
  GameplayStateValue,
  LegacyFrameRateSetting,
  LoopNode,
  MoveDirection,
  MovePlayerNode,
  NodeRunResult,
  NodeRunStatus,
  OcrResult,
  Point2D,
  RecognizeNode,
  RecognizeStrategyKey,
  RecognizeStrategyRun,
  ScreenshotNode,
  SpatialDetectorNode,
  SpatialObservationStore,
  SpatialResult,
  StreamFrameRate,
  StreamSourceProfile,
  TemplateDefinition,
  VisionOverlayMarker,
  VisionOverlayPayload,
  VisionOverlaySourceKind,
  WorkflowDocument,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunHandle,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  YoloDetection,
  YoloModel,
} from '@nobowo/core';
import { runVisionEngine, writeImageToTemp, YoloInferenceSession } from './engine';
import { findOcrMatch, normalizeOcrText, recognizeWithMacosVision } from './ocr';
import { templateImagesDir, templateIndexFile } from './templateStorage';
import { getPs5RuntimeClient } from './ps5Runtime';

const STRATEGY_NAMES: Record<RecognizeStrategyKey, string> = {
  coords: '坐标回放',
  template: '模板匹配',
  yolo: 'YOLO',
  ocr: 'OCR',
  cloudApi: '云端 API',
};

// ===== 只读存储辅助（与 main.ts 保持一致；执行引擎运行时只读不写这些数据）=====

async function loadTemplateIndex(): Promise<{ folders: unknown[]; templates: Array<Record<string, unknown>> }> {
  try {
    const raw = await readFile(templateIndexFile(), 'utf8');
    const parsed = JSON.parse(raw) as { folders?: unknown[]; templates?: unknown[] };
    return { folders: parsed.folders ?? [], templates: (parsed.templates ?? []) as Array<Record<string, unknown>> };
  } catch {
    return { folders: [], templates: [] };
  }
}

const cloudApiProfilesFile = () => join(app.getPath('userData'), 'api-profiles.json');

async function loadCloudApiIndex(): Promise<{ profiles: CloudApiProfile[] }> {
  try {
    const raw = await readFile(cloudApiProfilesFile(), 'utf8');
    const parsed = JSON.parse(raw) as { profiles?: CloudApiProfile[] };
    return { profiles: parsed.profiles ?? [] };
  } catch {
    return { profiles: [] };
  }
}

const streamSourcesFile = () => join(app.getPath('userData'), 'stream-sources.json');

async function loadStreamSources(): Promise<{ sources: StreamSourceProfile[] }> {
  try {
    const raw = await readFile(streamSourcesFile(), 'utf8');
    const parsed = JSON.parse(raw) as { sources?: unknown[] } | unknown[];
    if (Array.isArray(parsed)) {
      return { sources: parsed as StreamSourceProfile[] };
    }
    const obj = parsed as { sources?: unknown[] };
    return { sources: (obj.sources ?? []) as StreamSourceProfile[] };
  } catch {
    return { sources: [] };
  }
}

const yoloRootDir = () => join(app.getPath('userData'), 'yolo');
const yoloModelsDir = () => join(yoloRootDir(), 'models');
const yoloIndexFile = () => join(yoloRootDir(), 'index.json');
const yoloSettingsFile = () => join(yoloRootDir(), 'settings.json');
const datasetFile = (id: string) => join(yoloRootDir(), 'datasets', id, 'dataset.json');

async function loadYoloIndex(): Promise<{ models: Array<Record<string, unknown>> }> {
  try {
    const raw = await readFile(yoloIndexFile(), 'utf8');
    const parsed = JSON.parse(raw) as { models?: unknown[] };
    return { models: (parsed.models ?? []) as Array<Record<string, unknown>> };
  } catch {
    return { models: [] };
  }
}

async function loadDatasetFile(datasetId: string): Promise<{ classes: Array<{ name: string }> }> {
  try {
    const raw = await readFile(datasetFile(datasetId), 'utf8');
    const parsed = JSON.parse(raw) as { classes?: unknown[] };
    return { classes: (parsed.classes ?? []) as Array<{ name: string }> };
  } catch {
    return { classes: [] };
  }
}

async function resolveYoloxPath(): Promise<string | null> {
  try {
    const raw = await readFile(yoloSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as { yoloxPath?: string };
    if (parsed.yoloxPath) return parsed.yoloxPath;
  } catch {
    // 使用默认路径
  }
  const candidates = [
    join(app.getAppPath(), 'third_party', 'YOLOX'),
    join(process.resourcesPath, 'third_party', 'YOLOX'),
    join(app.getPath('userData'), 'yolox'),
  ];
  for (const candidate of candidates) {
    try {
      await stat(join(candidate, 'yolox', '__init__.py'));
      return candidate;
    } catch {
      // 继续检查下一个候选目录
    }
  }
  return null;
}

const OCR_DATA_DIR = () => join(app.getPath('userData'), 'ocr');

async function ensureOcrLangData(): Promise<{ langPath: string; gzip: boolean }> {
  const dir = OCR_DATA_DIR();
  await mkdir(dir, { recursive: true });
  const gzPath = join(dir, 'eng.traineddata.gz');
  const rawPath = join(dir, 'eng.traineddata');
  try {
    await stat(gzPath);
    return { langPath: dir, gzip: true };
  } catch {
    // continue
  }
  try {
    await stat(rawPath);
    return { langPath: dir, gzip: false };
  } catch {
    return { langPath: join(app.getAppPath(), 'resources', 'ocr'), gzip: true };
  }
}

// ===== 执行引擎 =====

type RunContext = {
  lastFrame: string | null;
  lastRecognize: { x: number; y: number; nodeId: string; strategy?: RecognizeStrategyKey } | null;
  lastSpatial: SpatialResult | null;
  lastGameplayState: GameplayStateValue | null;
  lastGameplayStateChanged: boolean;
  lastCapture: {
    source: 'screen' | 'window' | 'stream';
    sourceKind: VisionOverlaySourceKind;
    streamSourceId?: string;
    originX: number;
    originY: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    windowHint?: string;
    windowId?: number;
    displayId?: string;
  } | null;
};

type SpatialCaptureContext = {
  width: number;
  height: number;
  sourceKind?: VisionOverlaySourceKind;
  streamSourceId?: string;
};

type EvalContext = {
  last: { x: number; y: number; nodeId: string; strategy?: RecognizeStrategyKey } | null;
  lastOk: boolean;
  frame: boolean;
  spatial: SpatialResult | null;
  gameplayState: GameplayStateValue | null;
  gameplayStateChanged: boolean;
  results: Record<string, NodeRunResult>;
};

type TemplateStrategyConfig = {
  templateId?: string;
  templatePath?: string;
  threshold?: number;
};

type YoloStrategyConfig = {
  modelId?: string;
  modelPath?: string;
  label?: string;
  threshold?: number;
};

type OcrStrategyConfig = {
  text: string;
  engine?: string;
  lang?: 'auto' | 'eng' | 'chi_sim';
  threshold?: number;
};

type CloudApiStrategyConfig = {
  profileId?: string;
  apiIds?: string[];
  prompt?: string;
  url?: string;
  apiKey?: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseBounds(raw: string): { x: number; y: number; width: number; height: number } | null {
  const nums = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 4) return null;
  const [x, y, width, height] = nums.slice(-4).map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) return null;
  return { x, y, width, height };
}

function getMacWindowOwnerById(windowId?: number): string | null {
  if (!windowId) return null;
  const script = `import json
try:
    import Quartz
except Exception:
    print(json.dumps(None))
    raise SystemExit(0)
window_id = int(${JSON.stringify(windowId)})
options = Quartz.kCGWindowListOptionAll | Quartz.kCGWindowListExcludeDesktopElements
windows = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []
for win in windows:
    if int(win.get(Quartz.kCGWindowNumber, 0) or 0) == window_id:
        print(json.dumps(win.get(Quartz.kCGWindowOwnerName, "") or ""))
        raise SystemExit(0)
print(json.dumps(None))`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  try {
    const out = JSON.parse(String(res.stdout ?? '').trim() || 'null') as string | null;
    return out?.trim() ? out : null;
  } catch {
    return null;
  }
}

function getMacWindowBoundsById(windowId?: number): { x: number; y: number; width: number; height: number } | null {
  if (!windowId) return null;
  const script = `import json
try:
    import Quartz
except Exception:
    print(json.dumps(None))
    raise SystemExit(0)
window_id = int(${JSON.stringify(windowId)})
options = Quartz.kCGWindowListOptionAll | Quartz.kCGWindowListExcludeDesktopElements
windows = Quartz.CGWindowListCopyWindowInfo(options, Quartz.kCGNullWindowID) or []
for win in windows:
    if int(win.get(Quartz.kCGWindowNumber, 0) or 0) == window_id:
        bounds = win.get(Quartz.kCGWindowBounds, {}) or {}
        print(json.dumps({
            "x": float(bounds.get("X", 0)),
            "y": float(bounds.get("Y", 0)),
            "width": float(bounds.get("Width", 0)),
            "height": float(bounds.get("Height", 0)),
        }))
        raise SystemExit(0)
print(json.dumps(None))`;
  const res = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  try {
    const out = JSON.parse(String(res.stdout ?? '').trim() || 'null') as { x: number; y: number; width: number; height: number } | null;
    if (!out) return null;
    if ([out.x, out.y, out.width, out.height].some((n) => !Number.isFinite(n))) return null;
    return out;
  } catch {
    return null;
  }
}

function getMacWindowBoundsByHint(hint?: string): { x: number; y: number; width: number; height: number } | null {
  const search = hint?.trim();
  if (!search) return null;
  const script = `set targetHint to ${JSON.stringify(search)}
 tell application "System Events"
   repeat with p in application processes
     repeat with w in windows of p
       try
         set wn to name of w
         if wn contains targetHint then
           set pos to position of w
           set sz to size of w
           return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
         end if
       end try
     end repeat
   end repeat
 end tell`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const out = String(res.stdout ?? '').trim();
  return parseBounds(out);
}

function activateMacWindowByHint(hint?: string): boolean {
  const search = hint?.trim();
  if (!search) return false;
  const script = `set targetHint to ${JSON.stringify(search)}
 tell application "System Events"
   repeat with p in application processes
     repeat with w in windows of p
       try
         set wn to name of w
         if wn contains targetHint then
           tell p to set frontmost to true
           perform action "AXRaise" of w
           return "ok"
         end if
       end try
     end repeat
   end repeat
 end tell`;
  const res = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return res.status === 0 && String(res.stdout ?? '').includes('ok');
}

type MoveInputController = {
  apply: (
    direction: MoveDirection,
    spatial?: SpatialResult,
  ) => Promise<{ vector: Point2D; magnitude: number }>;
  release: () => Promise<void>;
};

export class WorkflowExecutor {
  private workflow: WorkflowDocument | null = null;
  private runId: string | null = null;
  private status: WorkflowRunStatus = 'idle';
  private startedAt: number | null = null;
  private paused: 'none' | 'user' | 'fail' = 'none';
  private stopped = false;
  private resumeRetry = false;
  private runGeneration = 0;
  private pauseWaiters: Array<() => void> = [];
  private currentNodeId: string | null = null;
  private currentStep = 0;
  private context: RunContext = {
    lastFrame: null,
    lastRecognize: null,
    lastSpatial: null,
    lastGameplayState: null,
    lastGameplayStateChanged: false,
    lastCapture: null,
  };
  private spatialStableFrames: Record<string, number> = {};
  private spatialObservations: Record<string, SpatialObservationStore> = {};
  private gameplayStateTrackers: Record<string, GameplayStateTracker> = {};
  private yoloSession: YoloInferenceSession | null = null;
  private yoloSessionKey = '';
  private nodeStates: Record<string, NodeRunStatus> = {};
  private nodeResults: Record<string, NodeRunResult> = {};
  private onEventCallback: ((event: WorkflowRunEvent) => void) | null = null;

  onEvent(callback: (event: WorkflowRunEvent) => void): void {
    this.onEventCallback = callback;
  }

  getSnapshot(): WorkflowRunSnapshot {
    return {
      runId: this.runId,
      status: this.status,
      startedAt: this.startedAt,
      nodeStates: { ...this.nodeStates },
      nodeResults: { ...this.nodeResults },
    };
  }

  private emit(event: WorkflowRunEvent): void {
    this.onEventCallback?.(event);
  }

  private resetYoloSession(): void {
    const session = this.yoloSession;
    this.yoloSession = null;
    this.yoloSessionKey = '';
    if (session) void session.close();
  }

  private async resolveProcessingFrameRate(
    setting: LegacyFrameRateSetting | undefined,
    source: 'screen' | 'window' | 'stream',
    streamSourceId?: string,
  ): Promise<StreamFrameRate> {
    let sourceFrameRate: StreamFrameRate | undefined;
    if (source === 'stream' && streamSourceId) {
      const profile = (await loadStreamSources()).sources.find((item) => item.id === streamSourceId);
      sourceFrameRate = profile?.captureFps ?? profile?.ps5Fps;
    } else if (source === 'screen' || source === 'window') {
      sourceFrameRate = 60;
    }
    return resolveFrameRateSetting(setting, sourceFrameRate);
  }

  async run(workflow: WorkflowDocument): Promise<WorkflowRunHandle> {
    if (!Array.isArray(workflow?.nodes) || workflow.nodes.length === 0) {
      return { started: false, message: '工作流为空，请先添加节点' };
    }
    // 点击运行 = 重新开始：先终止任何进行中的旧运行
    this.runGeneration += 1;
    const generation = this.runGeneration;
    if (this.status === 'running' || this.status === 'paused') {
      const oldRunId = this.runId;
      this.stopped = true;
      this.paused = 'none';
      const waiters = this.pauseWaiters.splice(0);
      for (const resolve of waiters) resolve();
      this.status = 'stopped';
      this.emit({ t: 'stopped', runId: oldRunId!, message: '已由新的运行替代' });
    }
    this.workflow = workflow;
    this.runId = randomUUID();
    this.status = 'running';
    this.startedAt = Date.now();
    this.paused = 'none';
    this.stopped = false;
    this.resumeRetry = false;
    this.pauseWaiters = [];
    this.currentNodeId = null;
    this.currentStep = 0;
    this.context = {
      lastFrame: null,
      lastRecognize: null,
      lastSpatial: null,
      lastGameplayState: null,
      lastGameplayStateChanged: false,
      lastCapture: null,
    };
    this.gameplayStateTrackers = {};
    this.spatialStableFrames = {};
    this.spatialObservations = {};
    this.nodeStates = {};
    this.nodeResults = {};
    this.resetYoloSession();

    this.emit({ t: 'start', runId: this.runId, nodeCount: workflow.nodes.filter((n) => n.enabled !== false).length });
    void this.execute(generation);
    return { started: true, runId: this.runId };
  }

  pause(): { ok: boolean; message?: string } {
    if (this.status !== 'running') return { ok: false, message: '当前没有运行中的工作流' };
    this.paused = 'user';
    this.status = 'paused';
    this.emit({ t: 'pause', runId: this.runId!, nodeId: this.currentNodeId ?? undefined });
    return { ok: true };
  }

  resume(opts?: { retry?: boolean }): { ok: boolean; message?: string } {
    if (this.status !== 'paused') return { ok: false, message: '当前工作流没有处于暂停状态' };
    this.resumeRetry = Boolean(opts?.retry);
    this.paused = 'none';
    this.status = 'running';
    const waiters = this.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
    this.emit({ t: 'resume', runId: this.runId! });
    return { ok: true };
  }

  stop(): { ok: boolean; message?: string } {
    if (this.status !== 'running' && this.status !== 'paused') {
      return { ok: false, message: '当前没有运行中的工作流' };
    }
    this.stopped = true;
    this.paused = 'none';
    this.status = 'stopped';
    const waiters = this.pauseWaiters.splice(0);
    for (const resolve of waiters) resolve();
    return { ok: true };
  }

  // ===== 主循环 =====

  private async execute(generation: number): Promise<void> {
    const runId = this.runId!;
    const workflow = this.workflow!;
    const startedAt = this.startedAt ?? Date.now();
    const isCurrent = () => this.runGeneration === generation && !this.stopped;

    try {
      const hasIncoming = new Set(workflow.edges.map((edge) => edge.target));
      const entries = workflow.nodes.filter((node) => !hasIncoming.has(node.id));
      const orderedEntries =
        entries.length > 0 ? entries : [workflow.nodes[0]];

      for (const entry of orderedEntries) {
        if (!isCurrent()) break;
        await this.executeChain(entry.id, null, generation);
      }
    } catch (err) {
      if (this.runGeneration !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ t: 'log', runId, level: 'error', message: `工作流执行出错：${message}` });
      this.status = 'error';
      this.emit({
        t: 'done',
        runId,
        summary: {
          ok: false,
          nodeCount: workflow.nodes.length,
          failedNodeIds: Object.values(this.nodeResults)
            .filter((result) => result.status === 'fail')
            .map((result) => result.nodeId),
          durationMs: Date.now() - startedAt,
          message,
        },
      });
      this.resetYoloSession();
      return;
    }

    if (this.runGeneration !== generation) return;
    if (this.stopped || this.status === 'stopped') {
      this.status = 'stopped';
      this.emit({ t: 'stopped', runId, message: '工作流已停止' });
      this.resetYoloSession();
      return;
    }
    if (this.status === 'paused') {
      return;
    }

    const failedIds = Object.values(this.nodeResults)
      .filter((result) => result.status === 'fail')
      .map((result) => result.nodeId);
    this.status = 'done';
    this.resetYoloSession();
    this.emit({
      t: 'done',
      runId,
      summary: {
        ok: failedIds.length === 0,
        nodeCount: workflow.nodes.length,
        failedNodeIds: failedIds,
        durationMs: Date.now() - startedAt,
        message: failedIds.length === 0 ? '工作流执行完成' : `有 ${failedIds.length} 个节点执行失败`,
      },
    });
  }

  /** 按节点 id 查找工作流节点。 */
  private findNode(nodeId: string): WorkflowNode | null {
    return this.workflow?.nodes.find((node) => node.id === nodeId) ?? null;
  }

  /** 暂停检查点：用户暂停时在此等待，返回 false 表示应当停止 */
  private async checkpoint(generation: number): Promise<boolean> {
    if (this.runGeneration !== generation || this.stopped) return false;
    while (this.paused === 'user' && !this.stopped && this.runGeneration === generation) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
    }
    return this.runGeneration === generation && !this.stopped;
  }

  private async waitForResumeOrStop(generation: number): Promise<void> {
    while (
      (this.paused === 'user' || this.paused === 'fail') &&
      !this.stopped &&
      this.runGeneration === generation
    ) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
    }
  }

  /** 沿单链执行：loopBackId 指回循环节点时表示一次循环体迭代结束 */
  private async executeChain(startNodeId: string, loopBackId: string | null, generation: number): Promise<void> {
    const runId = this.runId!;
    const isCurrent = () => this.runGeneration === generation && !this.stopped;
    let current = startNodeId;

    while (current && isCurrent()) {
      if (!(await this.checkpoint(generation))) return;
      const node = this.workflow!.nodes.find((item) => item.id === current);
      if (!node) {
        this.emit({ t: 'log', runId, level: 'warn', message: `找不到节点：${current}` });
        return;
      }

      if (node.enabled === false) {
        this.nodeStates[node.id] = 'skipped';
        const result: NodeRunResult = { nodeId: node.id, status: 'skipped', message: '节点已停用，跳过' };
        this.nodeResults[node.id] = result;
        this.currentStep += 1;
        this.emit({ t: 'nodeStart', runId, nodeId: node.id, step: this.currentStep, totalSteps: this.workflow?.nodes.length });
        this.emit({ t: 'nodeEnd', runId, nodeId: node.id, result });
        const next = this.resolveNext(node, result);
        if (loopBackId && next === loopBackId) return;
        if (!next) return;
        current = next;
        continue;
      }

      this.currentNodeId = node.id;
      this.nodeStates[node.id] = 'running';
      this.emit({ t: 'nodeStart', runId, nodeId: node.id });

      const startedAt = Date.now();
      let result: NodeRunResult;
      try {
        result = await this.executeNode(node, generation);
      } catch (err) {
        result = { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
      }
      result.elapsedMs = Date.now() - startedAt;
      this.currentNodeId = null;
      this.nodeStates[node.id] = result.status;
      this.nodeResults[node.id] = result;
      this.emit({ t: 'nodeEnd', runId, nodeId: node.id, result });

      if (result.status === 'fail') {
        this.paused = 'fail';
        this.status = 'paused';
        this.emit({ t: 'pause', runId, nodeId: node.id, message: result.message ?? '节点执行失败' });
        await this.waitForResumeOrStop(generation);
        if (!isCurrent()) return;
        if (this.resumeRetry) {
          current = node.id;
          continue;
        }
        const next = this.resolveNext(node, result);
        if (loopBackId && next === loopBackId) return;
        if (!next) return;
        current = next;
        continue;
      }

      const next = this.resolveNext(node, result);
      if (loopBackId && next === loopBackId) return;
      if (!next) return;
      current = next;
    }
  }

  private resolveNext(node: WorkflowNode, result: NodeRunResult): string | null {
    if (node.type === 'spatialDetector' && result.moveIntegrated) {
      const moveId = this.nextOf(node.id, 'out');
      return moveId ? this.nextOf(moveId, 'out') : null;
    }
    if (node.type === 'if') return this.nextOf(node.id, result.branch ?? 'false');
    if (node.type === 'loop') {
      // 循环的出口始终是配对 Down 的 out 端口（Begin 只标记循环体起点）
      const loop = node as LoopNode;
      if (loop.data.role === 'down') return this.nextOf(loop.id, 'out');
      const paired = this.findLoopPair(loop, 'down');
      return paired ? this.nextOf(paired.id, 'out') : null;
    }
    return this.nextOf(node.id, 'out');
  }

  private nextOf(nodeId: string, port: string): string | null {
    const edge = this.workflow!.edges.find(
      (item) => item.source === nodeId && ((item.sourcePort ?? 'out') === port || (port === 'body' && item.sourcePort === 'begin') || (port === 'done' && item.sourcePort === 'down')),
    );
    return edge?.target ?? null;
  }

  // ===== 节点执行 =====

  private async executeNode(node: WorkflowNode, generation: number): Promise<NodeRunResult> {
    const runId = this.runId!;
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.emit({ t: 'log', runId, level, message, nodeId: node.id });

    switch (node.type) {
      case 'click': {
        const rec = this.context.lastRecognize;
        if (!rec) {
          return { nodeId: node.id, status: 'fail', message: '没有可用的识别坐标，请先执行一个 recognize 节点' };
        }
        const capture = this.context.lastCapture;
        if (!capture) {
          return { nodeId: node.id, status: 'fail', message: '没有可用的截图上下文，请先执行 screenshot 节点' };
        }
        const captureLabel = `capture=${capture.width}×${capture.height} origin=(${capture.originX.toFixed(0)}, ${capture.originY.toFixed(0)}) scale=(${capture.scaleX.toFixed(4)}, ${capture.scaleY.toFixed(4)})`;
        const recognizeLabel = `recognize=(${rec.x.toFixed(1)}, ${rec.y.toFixed(1)})`;
        const relX = capture.width > 0 ? Math.min(1, Math.max(0, rec.x / capture.width)) : 0.5;
        const relY = capture.height > 0 ? Math.min(1, Math.max(0, rec.y / capture.height)) : 0.5;
        const relLabel = `rel=(${relX.toFixed(4)}, ${relY.toFixed(4)})`;
        const absX = Math.round(capture.originX + rec.x * capture.scaleX);
        const absY = Math.round(capture.originY + rec.y * capture.scaleY);
        const absLabel = `abs=(${absX}, ${absY})`;
        log('info', `${captureLabel} · ${recognizeLabel} · ${relLabel} · ${absLabel}`);

        if (capture.windowId || capture.windowHint) {
          const boundsById = capture.windowId ? getMacWindowBoundsById(capture.windowId) : null;
          const boundsByHint = !boundsById && capture.windowHint ? getMacWindowBoundsByHint(capture.windowHint) : null;
          const bounds = boundsById ?? boundsByHint;
          const boundsSource = boundsById ? 'id' : boundsByHint ? 'hint' : 'none';

          if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
            log('error', [
              '窗口边界解析失败',
              `windowId=${capture.windowId ?? 'null'}`,
              `windowHint=${capture.windowHint ?? 'null'}`,
              `recognize=(${rec.x.toFixed(1)}, ${rec.y.toFixed(1)})`,
              `capture=(${capture.width}×${capture.height})`,
              `origin=(${capture.originX.toFixed(0)}, ${capture.originY.toFixed(0)})`,
              `scale=(${capture.scaleX.toFixed(4)}, ${capture.scaleY.toFixed(4)})`,
              `boundsSource=${boundsSource}`,
              '已中止本次点击，避免点到错误位置',
            ].join(' · '));
            return { nodeId: node.id, status: 'fail', message: '窗口边界解析失败，无法安全点击；请查看调试日志中的 windowId / windowHint / boundsSource' };
          }

          const hitX = Math.round(bounds.x + bounds.width * relX);
          const hitY = Math.round(bounds.y + bounds.height * relY);
          const hitLabel = `(${hitX}, ${hitY})`;
          const relToBoundsX = bounds.width > 0 ? (hitX - bounds.x) / bounds.width : 0;
          const relToBoundsY = bounds.height > 0 ? (hitY - bounds.y) / bounds.height : 0;
          const screenAtPoint = screen.getDisplayNearestPoint({ x: hitX, y: hitY });
          const displays = screen.getAllDisplays().map((d) => ({
            id: String(d.id),
            bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
            workArea: { x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height },
            scaleFactor: d.scaleFactor,
          }));
          const windowInDisplayX = hitX - screenAtPoint.bounds.x;
          const windowInDisplayY = hitY - screenAtPoint.bounds.y;
          const windowInDisplayRelX = screenAtPoint.bounds.width > 0 ? windowInDisplayX / screenAtPoint.bounds.width : 0;
          const windowInDisplayRelY = screenAtPoint.bounds.height > 0 ? windowInDisplayY / screenAtPoint.bounds.height : 0;
          // 点击窗口时先激活目标窗口。运行面板可能覆盖在目标窗口上方，
          // 直接发送全局坐标会把点击交给 NoBoWo 自己，而不是截图对应的窗口。
          const res = await runVisionEngine(
            'input',
            {
              action: 'click_window',
              windowId: capture.windowId,
              windowHint: capture.windowHint,
              relX,
              relY,
            },
            30000,
          );
          if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '点击失败' };
          const target = res.target as Record<string, unknown> | undefined;
          const actual = res.actual as Record<string, unknown> | undefined;
          const actualLabel = actual ? `，鼠标实际落在 (${(actual.x as number).toFixed(0)}, ${(actual.y as number).toFixed(0)})` : '';
          const targetLabel = target ? ` target=(${(target.x as number).toFixed(0)}, ${(target.y as number).toFixed(0)})` : '';
          const matchedBy = res.matchedBy === 'hint' ? '标题回退' : res.matchedBy === 'id' ? '窗口ID精确' : '?';
          log('info', `窗口边界[${boundsSource}]=${JSON.stringify(bounds)} · relInCapture=${relX.toFixed(4)},${relY.toFixed(4)} · relInBounds=${relToBoundsX.toFixed(4)},${relToBoundsY.toFixed(4)} · hit=${hitLabel}${targetLabel}${actualLabel} · 激活方式=${matchedBy}`);
          log('info', `displayAtPoint=${JSON.stringify({ id: String(screenAtPoint.id), bounds: screenAtPoint.bounds, workArea: screenAtPoint.workArea, scaleFactor: screenAtPoint.scaleFactor })} · windowInDisplay=(${windowInDisplayX.toFixed(0)}, ${windowInDisplayY.toFixed(0)}) · relInDisplay=${windowInDisplayRelX.toFixed(4)},${windowInDisplayRelY.toFixed(4)}`);
          log('info', `allDisplays=${JSON.stringify(displays)}`);
          return {
            nodeId: node.id,
            status: 'ok',
            hitCoords: { x: rec.x, y: rec.y },
            actualClickCoords: actual && typeof actual.x === 'number' && typeof actual.y === 'number'
              ? { x: actual.x, y: actual.y }
              : undefined,
            message: `点击窗口相对位置 (${relX.toFixed(4)}, ${relY.toFixed(4)})${actualLabel}`,
          };
        }

        if (capture.displayId) {
          const display = screen.getAllDisplays().find((d) => String(d.id) === String(capture.displayId)) ?? screen.getPrimaryDisplay();
          const displayInfo = { id: String(display.id), bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor };
          // 屏幕截图和 CGEvent 点击都在 Quartz 层按同一个 displayId/相对坐标换算，
          // 避免 Retina 屏幕下 Electron 坐标与鼠标坐标出现比例偏差。
          const res = await runVisionEngine(
            'input',
            { action: 'click_screen', displayId: capture.displayId, relX, relY },
            30000,
          );
          if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '点击失败' };
          const target = res.target as Record<string, unknown> | undefined;
          const actual = res.actual as Record<string, unknown> | undefined;
          const actualLabel = actual ? `，鼠标实际落在 (${(actual.x as number).toFixed(0)}, ${(actual.y as number).toFixed(0)})` : '';
          const targetLabel = target ? ` target=(${(target.x as number).toFixed(0)}, ${(target.y as number).toFixed(0)})` : '';
          log('info', `Quartz 屏幕点击 · relInCapture=(${relX.toFixed(4)}, ${relY.toFixed(4)})${targetLabel}${actualLabel} · display=${JSON.stringify(displayInfo)}`);
          return {
            nodeId: node.id,
            status: 'ok',
            hitCoords: { x: rec.x, y: rec.y },
            actualClickCoords: actual && typeof actual.x === 'number' && typeof actual.y === 'number'
              ? { x: actual.x, y: actual.y }
              : undefined,
            message: `点击屏幕相对位置 (${relX.toFixed(4)}, ${relY.toFixed(4)})${actualLabel}`,
          };
        }

        const res = await runVisionEngine('input', { action: 'click', x: absX, y: absY }, 30000);
        if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '点击失败' };
        const target = res.target as Record<string, unknown> | undefined;
        const actual = res.actual as Record<string, unknown> | undefined;
        const actualLabel = actual ? `，鼠标实际落在 (${(actual.x as number).toFixed(0)}, ${(actual.y as number).toFixed(0)})` : '';
        const targetLabel = target ? ` target=(${(target.x as number).toFixed(0)}, ${(target.y as number).toFixed(0)})` : '';
        log('info', `点击完成 ${absLabel}${targetLabel}${actualLabel}`);
        return {
          nodeId: node.id,
          status: 'ok',
          hitCoords: { x: rec.x, y: rec.y },
          actualClickCoords: actual && typeof actual.x === 'number' && typeof actual.y === 'number'
            ? { x: actual.x, y: actual.y }
            : undefined,
          message: `点击 ${absLabel}${targetLabel}${actualLabel}`,
        };
      }

      case 'wait': {
        if (node.data.mode === 'condition' && node.data.conditionText?.trim()) {
          const expr = node.data.conditionText.trim();
          const deadline = Date.now() + 60000;
          log('info', `条件等待：${expr}`);
          while (Date.now() < deadline) {
            if (this.stopped || this.runGeneration !== generation) break;
            if (this.evalExpression(expr)) {
              return { nodeId: node.id, status: 'ok', message: `条件满足：${expr}` };
            }
            await sleep(200);
          }
          return { nodeId: node.id, status: 'fail', message: `条件等待超时（60s）：${expr}` };
        }
        const ms = Math.max(0, node.data.delayMs ?? 1000);
        log('info', `等待 ${ms}ms`);
        await sleep(ms);
        return { nodeId: node.id, status: 'ok', message: `等待 ${ms}ms` };
      }

      case 'screenshot': {
        const captured = await this.captureNodeImage(node);
        if (!captured.ok) return { nodeId: node.id, status: 'fail', message: captured.message };
        this.context.lastFrame = captured.frame!;
        this.context.lastCapture = {
          source: node.data.source,
          sourceKind: captured.sourceKind ?? 'other',
          streamSourceId: captured.streamSourceId,
          originX: captured.originX ?? 0,
          originY: captured.originY ?? 0,
          width: captured.width ?? 0,
          height: captured.height ?? 0,
          scaleX: captured.scaleX ?? 1,
          scaleY: captured.scaleY ?? 1,
          windowHint: node.data.windowHint,
          windowId: captured.windowId,
          displayId: captured.displayId,
        };
        log('info', `截图成功（${captured.width}×${captured.height}）`);
        return {
          nodeId: node.id,
          status: 'ok',
          frame: captured.frame,
          width: captured.width,
          height: captured.height,
          message: `截图成功（${captured.width}×${captured.height}）`,
        };
      }

      case 'if': {
        const conditionType = node.data.conditionType ?? 'lastOk';
        let expr = node.data.expression?.trim() || 'true';

        // Auto-generate expression based on conditionType if not custom
        if (conditionType !== 'custom') {
          switch (conditionType) {
            case 'lastOk':
              expr = 'ctx.lastOk';
              break;
            case 'nodeCheck': {
              // Find node by title
              const targetTitle = node.data.targetNodeTitle ?? '';
              const targetNode = this.workflow?.nodes.find((n) => n.title === targetTitle);
              expr = targetNode ? `ctx.results['${targetNode.id}']?.status === 'ok'` : 'ctx.lastOk';
              break;
            }
            case 'spatialArrived':
              expr = 'ctx.spatial?.arrived === true';
              break;
            case 'spatialNotArrived':
              expr = 'ctx.spatial?.arrived !== true';
              break;
            case 'gameplayOffense':
              expr = 'ctx.gameplayState === "offense"';
              break;
            case 'gameplayDefense':
              expr = 'ctx.gameplayState === "defense"';
              break;
            case 'gameplayStateChanged':
              expr = 'ctx.gameplayStateChanged === true';
              break;
          }
        }

        let branch: 'true' | 'false';
        try {
          branch = this.evalExpression(expr) ? 'true' : 'false';
        } catch (err) {
          return {
            nodeId: node.id,
            status: 'fail',
            message: `表达式求值失败：${err instanceof Error ? err.message : String(err)}`,
          };
        }

        const conditionLabel = conditionType === 'lastOk' ? '上一次节点' :
          conditionType === 'nodeCheck' ? `指定节点：${node.data.targetNodeTitle ?? '未选择'}` :
          conditionType === 'spatialArrived' ? '空间检测已到达' :
          conditionType === 'spatialNotArrived' ? '空间检测未到达' :
          conditionType === 'gameplayOffense' ? '游戏状态为进攻' :
          conditionType === 'gameplayDefense' ? '游戏状态为防守' :
          conditionType === 'gameplayStateChanged' ? '攻防状态发生变化' :
          '自定义条件';

        log('info', `条件「${conditionLabel}」为${branch === 'true' ? '真' : '假'}`);
        return { nodeId: node.id, status: 'ok', branch, message: `条件「${conditionLabel}」→ ${branch === 'true' ? '真' : '假'}` };
      }

      case 'loop':
        return this.executeLoop(node, generation);

      case 'scroll': {
        const { direction } = node.data;
        const preset = node.data.preset ?? 'medium';
        const amount =
          preset === 'small' ? 1 :
          preset === 'medium' ? 3 :
          preset === 'large' ? 6 :
          Math.max(0, node.data.customAmount ?? 300);
        log('info', `滚动：${direction} ${preset}${preset === 'custom' ? ` ${amount}` : ''}`);
        const res = await runVisionEngine(
          'input',
          { action: 'scroll', direction, amount },
          15000,
        );
        if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '滚动失败' };
        return { nodeId: node.id, status: 'ok', message: `滚动：${direction} ${preset}${preset === 'custom' ? ` ${amount}` : ''}` };
      }

      case 'keyboard': {
        const { keys, mode, target, streamSourceId } = node.data;
        if (!keys) return { nodeId: node.id, status: 'fail', message: '按键内容为空' };
        log('info', `按键：${keys}（${mode}${mode === 'type' ? ` · 间隔 ${node.data.interval ?? 200}ms` : ''}）`);

        if (target === 'stream' && streamSourceId) {
          const profile = (await loadStreamSources()).sources.find((source) => source.id === streamSourceId);
          if (profile?.transport === 'ps5Direct') {
            try {
              const api = getPs5RuntimeClient();
              const keyNames = keys.split('+').map((key) => key.trim()).filter(Boolean);
              if (mode === 'hold') {
                for (const key of keyNames) await api.sendKey(key, true);
              } else if (mode === 'type') {
                const interval = node.data.interval ?? 200;
                for (const key of keys) {
                  await api.sendKey(key, true);
                  await api.sendKey(key, false);
                  if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval));
                }
              } else {
                for (const key of keyNames) {
                  await api.sendKey(key, true);
                  await api.sendKey(key, false);
                }
              }
              return { nodeId: node.id, status: 'ok', message: `PS5 协议按键：${keys}（${mode}）` };
            } catch (err) {
              return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
            }
          }
        }

        const res = await runVisionEngine(
          'input',
          {
            action: 'key',
            keys,
            mode,
            interval: mode === 'type' ? (node.data.interval ?? 200) : undefined,
          },
          15000,
        );
        if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '按键失败' };
        return { nodeId: node.id, status: 'ok', message: `按键：${keys}（${mode}）` };
      }

      case 'gamepad': {
        const { action, target, streamSourceId, keyboardKey, durationMs, delayMs, useCdp, cdpPort, useSharedMemory } = node.data;
        if (!action) return { nodeId: node.id, status: 'fail', message: '手柄动作为空' };

        // Gamepad 的串流目标必须来自串流设备配置，不再接受节点里的手填窗口。
        let streamProfile: Pick<StreamSourceProfile, 'id' | 'name' | 'type' | 'windowHint' | 'windowId' | 'windowApp' | 'transport' | 'ps5AccountId' | 'host'> | undefined;
        if (target === 'stream') {
          if (!streamSourceId) return { nodeId: node.id, status: 'fail', message: '请选择要接收手柄输入的串流设备' };
          streamProfile = (await loadStreamSources()).sources.find((source) => source.id === streamSourceId);
          if (!streamProfile) return { nodeId: node.id, status: 'fail', message: '所选串流设备不存在，请在串流管理中重新配置' };
          if (streamProfile.transport !== 'ps5Direct' && !streamProfile.windowHint?.trim() && !streamProfile.windowId && !streamProfile.windowApp?.trim()) {
            return { nodeId: node.id, status: 'fail', message: `串流设备「${streamProfile.name || streamProfile.id}」尚未配置窗口标题` };
          }
        }
        const windowHint = streamProfile?.windowHint;
        const targetLabel = target === 'stream'
          ? ` → ${streamProfile?.name || streamSourceId}${windowHint ? ` · ${windowHint}` : ''}`
          : '';
        const customKeyboardKey = keyboardKey?.trim();
        log('info', customKeyboardKey
          ? `游戏键盘：${customKeyboardKey}（来源：${action}，目标：${target}${targetLabel}）`
          : `手柄按键：${action}（目标：${target}${targetLabel}，CDP：${useCdp ? '是' : '否'}，SharedMemory：${useSharedMemory ? '是' : '否'}）`);

        if (customKeyboardKey && streamProfile?.transport === 'ps5Direct') {
          return {
            nodeId: node.id,
            status: 'fail',
            message: `PS5 协议直连不能发送自定义键盘按键「${customKeyboardKey}」，请使用外部串流窗口或清空自定义按键`,
          };
        }

        if (!customKeyboardKey && streamProfile?.transport === 'ps5Direct') {
          try {
            const result = await getPs5RuntimeClient().sendButton(action, undefined, durationMs ?? 0);
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return {
              nodeId: node.id,
              status: 'ok',
              message: `PS5 协议手柄：${action} → ${result.button}（按下 ${result.durationMs ?? durationMs ?? 120}ms）`,
            };
          } catch (err) {
            return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
          }
        }

        const res = await runVisionEngine(
          'gamepad',
          {
            action,
            keyboardKey: customKeyboardKey || undefined,
            target,
            windowHint,
            windowId: streamProfile?.windowId,
            windowApp: streamProfile?.windowApp,
            durationMs: durationMs ?? 0,
            delayMs: delayMs ?? 100,
            useCdp: useCdp ?? false,
            cdpPort: cdpPort ?? 9222,
            useSharedMemory: useSharedMemory ?? false,
          },
          15000,
        );

        if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '手柄按键失败' };
        const delivery = res as { key?: string; method?: string; targetWindow?: { id?: number; title?: string } };
        const deliveryLabel = [
          customKeyboardKey ? `键盘 ${customKeyboardKey}` : `动作 ${action}`,
          delivery.key ? `key=${delivery.key}` : '',
          delivery.method ? `通道=${delivery.method}` : '',
          delivery.targetWindow?.title ? `窗口=${delivery.targetWindow.title}` : '',
        ].filter(Boolean).join(' · ');
        return { nodeId: node.id, status: 'ok', message: `已发送：${deliveryLabel}` };
      }

      case 'liveVision': {
        const source = node.data.source ?? 'stream';
        const fps = await this.resolveProcessingFrameRate(node.data.fps, source, node.data.streamSourceId);
        const timeoutMs = Math.max(500, node.data.timeoutMs ?? 5000);
        const detectMode = node.data.detectMode ?? 'yolo';
        const action = node.data.action ?? 'returnCoords';

        log('info', `实时检测：来源 ${source}，${fps} FPS，${timeoutMs}ms 超时，模式 ${detectMode}`);
        const start = Date.now();
        const frameInterval = Math.round(1000 / fps);
        const processingMetrics = () => ({
          targetFps: fps,
          processingFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)),
          processingFrameCount: frames,
        });
        let frames = 0;
        let hits = 0;
        let latestHit: { x: number; y: number; label?: string; confidence?: number } | null = null;

        const captureNode = {
          id: `${node.id}-cap`,
          type: 'screenshot',
          title: `${node.title} Frame`,
          position: node.position,
          enabled: true,
          data: {
            regionMode: 'full',
            source,
            streamSourceId: node.data.streamSourceId,
            windowHint: node.data.windowHint,
            windowId: node.data.windowId,
            windowApp: node.data.windowApp,
          },
        } as ScreenshotNode;

        while (!this.stopped && this.runGeneration === generation) {
          const iterationStartedAt = Date.now();
          if (Date.now() - start > timeoutMs) {
            return { nodeId: node.id, status: 'fail', message: `实时检测超时（${timeoutMs}ms）`, ...processingMetrics(), liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: latestHit ?? undefined };
          }

          const cap = await this.captureNodeImage(captureNode);
          if (!cap.ok || !cap.frame) {
            log('warn', `实时检测：本帧获取失败，继续等待新画面（${cap.message ?? '未知错误'}）`);
            const remainingFrameTime = frameInterval - (Date.now() - iterationStartedAt);
            if (remainingFrameTime > 0) await sleep(remainingFrameTime);
            continue;
          }
          const frame = cap.frame;
          frames += 1;
          let hit: { x: number; y: number; label?: string; confidence?: number } | null = null;
          const overlayMarkers: VisionOverlayMarker[] = [];

          if (detectMode === 'yolo' || detectMode === 'both' || detectMode === 'all') {
            if (node.data.yoloModelPath) {
              const detections = await this.runSpatialYolo(
                frame,
                node.data.yoloModelPath,
                undefined,
                undefined,
                node.data.yoloThreshold ?? 60,
              );
              for (const detection of detections) {
                const [x, y, width, height] = detection.box;
                overlayMarkers.push({
                  kind: 'box',
                  x,
                  y,
                  width,
                  height,
                  label: detection.label,
                  confidence: detection.confidence,
                });
              }
              const det = this.pickDetection(detections, node.data.yoloLabel ?? '');
              if (det?.box) {
                const [bx, by, bw, bh] = det.box;
                hit = { x: bx + bw / 2, y: by + bh / 2, label: det.label, confidence: det.confidence };
              }
            } else {
              log('warn', '实时检测：尚未选择 YOLO 模型，跳过本帧 YOLO');
            }
          }

          // Template matching
          if (!hit && (detectMode === 'template' || detectMode === 'both' || detectMode === 'all')) {
            const templateIdOrPath = node.data.templatePath;
            if (templateIdOrPath) {
              const imagePath = await writeImageToTemp(frame);
              if (imagePath) {
                // Resolve template ID to file path
                let templateFilePath = templateIdOrPath;
                try {
                  const idx = await loadTemplateIndex();
                  const tplDef = idx.templates.find((t: any) => t.id === templateIdOrPath) as any;
                  if (tplDef?.imageFile) {
                    templateFilePath = join(templateImagesDir(), tplDef.imageFile);
                  }
                } catch {}
                const res = await runVisionEngine(
                  'template',
                  {
                    imagePath,
                    templatePath: templateFilePath,
                    threshold: node.data.templateThreshold ?? 80,
                  },
                  20000,
                );
                if (res.ok) {
                  const result = res as { ok?: boolean; confidence?: number; clickX?: number; clickY?: number; x?: number; y?: number; width?: number; height?: number };
                  if (result.ok && result.x !== undefined && result.y !== undefined && result.width !== undefined && result.height !== undefined) {
                    overlayMarkers.push({
                      kind: 'box',
                      x: result.x,
                      y: result.y,
                      width: result.width,
                      height: result.height,
                      label: templateIdOrPath,
                      confidence: result.confidence,
                    });
                  }
                  if (result.ok && result.clickX !== undefined && result.clickY !== undefined) {
                    hit = { x: result.clickX, y: result.clickY, label: templateIdOrPath, confidence: result.confidence };
                  }
                }
              }
            }
          }

          if (!hit && (detectMode === 'ocr' || detectMode === 'all')) {
            const ocr = await this.runOcrStrategy(frame, {
              text: node.data.ocrText ?? '',
              engine: node.data.ocrEngine ?? 'auto',
              lang: node.data.ocrLang ?? 'auto',
              threshold: node.data.ocrThreshold ?? 60,
            });
            if (ocr.status === 'hit' && ocr.x !== undefined && ocr.y !== undefined) {
              overlayMarkers.push({
                kind: 'point',
                x: ocr.x,
                y: ocr.y,
                label: node.data.ocrText,
                confidence: ocr.confidence,
              });
              hit = {
                x: ocr.x,
                y: ocr.y,
                label: node.data.ocrText,
                confidence: ocr.confidence,
              };
            }
          }

          const overlay: VisionOverlayPayload = {
            sourceWidth: cap.width ?? 0,
            sourceHeight: cap.height ?? 0,
            sourceKind: cap.sourceKind ?? 'other',
            streamSourceId: cap.streamSourceId,
            markers: overlayMarkers,
          };
          this.emit({ t: 'visionOverlay', runId: this.runId!, nodeId: node.id, overlay });

          if (hit) {
            hits += 1;
            latestHit = hit;
            const hitLabel = hit.label ? `：${hit.label}` : '';
            const hitConf = typeof hit.confidence === 'number' ? `（${hit.confidence}%）` : '';
            const metrics = { ...processingMetrics(), liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: hit };
            if (action === 'returnCoords') {
              return { nodeId: node.id, status: 'ok', hitCoords: { x: hit.x, y: hit.y }, message: `检测到目标${hitLabel}${hitConf}`, ...metrics };
            }
            const clickRes = await runVisionEngine(
              'input',
              { action: 'click_window', windowId: cap.windowId, windowHint: node.data.windowHint, x: hit.x, y: hit.y },
              15000,
            );
            if (!clickRes.ok) return { nodeId: node.id, status: 'fail', message: clickRes.message ?? '检测到目标但点击失败', ...metrics };
            return { nodeId: node.id, status: 'ok', message: `检测到目标${hitLabel}${hitConf}并点击`, ...metrics };
          }

          const remainingFrameTime = frameInterval - (Date.now() - iterationStartedAt);
          if (remainingFrameTime > 0) await sleep(remainingFrameTime);
        }

        return { nodeId: node.id, status: 'fail', message: '实时检测被中止', ...processingMetrics(), liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: latestHit ?? undefined };
      }

      case 'gameplayState':
        return this.executeGameplayState(node, generation);

      case 'spatialDetector':
        return this.executeSpatialDetector(node, generation);

      case 'movePlayer':
        return this.executeMovePlayer(node, generation);

      case 'recognize': {
        const frame = this.context.lastFrame;
        if (!frame) {
          return {
            nodeId: node.id,
            status: 'fail',
            message: '没有可用的截图画面，请在 recognize 节点之前连接并执行一个 screenshot 节点',
          };
        }
        return this.runRecognize(node, frame);
      }
    }
  }

  /**
   * pairId 缺失或不一致时，按连线结构推断 Loop Begin/Down 的配对。
   * 结构约定：Begin.out → 循环体第一个节点 → … → Down.in，Down.out → 循环后继续的节点。
   */
  private findLoopPair(node: LoopNode, want: 'begin' | 'down'): LoopNode | undefined {
    const nodes = this.workflow!.nodes;
    const others = nodes.filter((candidate): candidate is LoopNode => candidate.type === 'loop' && candidate.id !== node.id && candidate.data.role === want);
    if (others.length === 0) return undefined;
    if (others.length === 1) return others[0];

    if (node.data.role === 'begin') {
      let current = this.nextOf(node.id, 'out');
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        const cur = nodes.find((candidate) => candidate.id === current);
        if (!cur) return undefined;
        if (cur.type === 'loop') return cur.data.role === 'down' ? (cur as LoopNode) : undefined;
        current = this.nextOf(cur.id, 'out');
      }
      return undefined;
    }

    const matching = others.filter((candidate) => {
      let current = this.nextOf(candidate.id, 'out');
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        if (current === node.id) return true;
        const cur = nodes.find((candidateNode) => candidateNode.id === current);
        if (!cur) return false;
        if (cur.type === 'loop') return false;
        current = this.nextOf(cur.id, 'out');
      }
      return false;
    });
    return matching.length === 1 ? matching[0] : undefined;
  }

  private async executeLoop(node: LoopNode, generation: number): Promise<NodeRunResult> {
    const runId = this.runId!;
    const pairId = node.data.pairId;
    const other = pairId
      ? this.workflow!.nodes.find((candidate) => candidate.type === 'loop' && candidate.data.pairId === pairId && candidate.id !== node.id) as LoopNode | undefined
      : undefined;

    // 优先按 pairId 配对；pairId 缺失或不一致时，按连线结构推断配对
    let begin: LoopNode | undefined;
    let down: LoopNode | undefined;
    if (node.data.role === 'begin') {
      begin = node;
      down = other?.data.role === 'down' ? other : this.findLoopPair(node, 'down');
    } else {
      down = node;
      begin = other?.data.role === 'begin' ? other : this.findLoopPair(node, 'begin');
    }
    if (!begin || !down) return { nodeId: node.id, status: 'fail', message: 'Loop Begin/Down 尚未配对' };

    const beginNext = this.nextOf(begin.id, 'out');
    if (!beginNext) return { nodeId: node.id, status: 'fail', message: 'Loop Begin 没有连接循环体' };

    const countLimit = begin.data.mode === 'count' ? Math.max(0, begin.data.count ?? 1) : 10000;
    const condition = begin.data.conditionText?.trim() || 'false';
    let executed = 0;
    this.emit({ t: 'log', runId, level: 'info', message: begin.data.mode === 'count' ? `开始循环 ${countLimit} 次` : `开始条件循环：${condition}`, nodeId: begin.id });

    while (!this.stopped && this.runGeneration === generation && executed < countLimit) {
      if (!(await this.checkpoint(generation))) break;
      if (begin.data.mode === 'condition') {
        let shouldContinue = false;
        try {
          shouldContinue = this.evalExpression(condition);
        } catch (err) {
          return { nodeId: node.id, status: 'fail', message: `循环条件求值失败：${err instanceof Error ? err.message : String(err)}` };
        }
        if (!shouldContinue) break;
      }

      let current: string | null = beginNext;
      const visited = new Set<string>();
      while (current && current !== down.id && !this.stopped && this.runGeneration === generation) {
        if (visited.has(current)) return { nodeId: node.id, status: 'fail', message: '循环体出现额外回路，请只连接到 Loop Down' };
        visited.add(current);
        const currentNode = this.findNode(current);
        if (!currentNode) return { nodeId: node.id, status: 'fail', message: `循环体节点不存在：${current}` };
        const result = await this.executeNodeWithEvents(currentNode, generation);
        if (result.status === 'fail') return { nodeId: node.id, status: 'fail', message: result.message ?? '循环体执行失败' };
        current = this.resolveNext(currentNode, result) ?? null;
      }
      if (current !== down.id) return { nodeId: node.id, status: 'fail', message: 'Loop Begin 到 Loop Down 之间没有形成完整循环体' };
      executed++;
      this.emit({ t: 'log', runId, level: 'debug', message: `循环第 ${executed} 次完成`, nodeId: begin.id });
    }

    this.emit({ t: 'log', runId, level: 'info', message: `Loop Down：循环完成，共 ${executed} 次`, nodeId: down.id });
    return { nodeId: node.id, status: 'ok', loopCount: executed, message: `循环执行 ${executed} 次，继续 Loop Down 后续步骤` };
  }

  private async executeNodeWithEvents(node: WorkflowNode, generation: number): Promise<NodeRunResult> {
    const runId = this.runId!;
    this.currentNodeId = node.id;
    this.nodeStates[node.id] = 'running';
    this.emit({ t: 'nodeStart', runId, nodeId: node.id });
    const startedAt = Date.now();
    let result: NodeRunResult;
    try {
      result = await this.executeNode(node, generation);
    } catch (err) {
      result = { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
    result.elapsedMs = Date.now() - startedAt;
    this.currentNodeId = null;
    this.nodeStates[node.id] = result.status;
    this.nodeResults[node.id] = result;
    this.emit({ t: 'nodeEnd', runId, nodeId: node.id, result });
    return result;
  }

  // ===== recognize 策略栈 =====

  private async runRecognize(node: RecognizeNode, frame: string): Promise<NodeRunResult> {
    const strategies = node.data.strategies;
    const order = node.data.strategyOrder ?? ['coords', 'template', 'yolo', 'ocr', 'cloudApi'];
    const mode = node.data.executionMode ?? 'cascade';
    const enabled = order.filter((key) => strategies[key]?.enabled);
    const runs: RecognizeStrategyRun[] = [];
    const finishResult = (result: NodeRunResult): NodeRunResult => {
      const visionOverlay = this.buildVisionOverlay(runs);
      return visionOverlay ? { ...result, visionOverlay } : result;
    };

    if (enabled.length === 0) {
      return finishResult({ nodeId: node.id, status: 'fail', message: '识别节点没有启用任何策略', strategies: runs });
    }

    const runOne = async (key: RecognizeStrategyKey): Promise<RecognizeStrategyRun> => {
      const startedAt = Date.now();
      const finish = (partial: Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>): RecognizeStrategyRun => ({
        key,
        elapsedMs: Date.now() - startedAt,
        ...partial,
      });
      try {
        switch (key) {
          case 'coords': {
            const { x, y } = strategies.coords;
            return finish({ status: 'hit', confidence: 100, x, y, message: `坐标回放 (${x}, ${y})` });
          }
          case 'template':
            return finish(await this.runTemplateStrategy(frame, strategies.template));
          case 'yolo':
            return finish(await this.runYoloStrategy(frame, strategies.yolo));
          case 'ocr':
            return finish(await this.runOcrStrategy(frame, strategies.ocr));
          case 'cloudApi':
            return finish(await this.runCloudApiStrategy(frame, strategies.cloudApi));
        }
      } catch (err) {
        return finish({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };

    const emitRunLog = (run: RecognizeStrategyRun) => {
      const label = STRATEGY_NAMES[run.key];
      const statusText =
        run.status === 'hit' ? '命中' : run.status === 'miss' ? '未命中' : run.status === 'error' ? '出错' : '跳过';
      const coordText =
        run.status === 'hit' && run.x !== undefined && run.y !== undefined ? ` @(${Math.round(run.x)}, ${Math.round(run.y)})` : '';
      this.emit({
        t: 'log',
        runId: this.runId!,
        level: run.status === 'hit' ? 'info' : run.status === 'miss' ? 'warn' : 'error',
        message: `${label}：${statusText}${coordText}${run.confidence !== undefined ? ` ${run.confidence}%` : ''}${run.message ? `（${run.message}）` : ''}`,
        nodeId: node.id,
      });
    };

    if (mode === 'parallel') {
      const results = await Promise.all(enabled.map(runOne));
      runs.push(...results);
      for (const run of runs) emitRunLog(run);
      const hits = results.filter((run) => run.status === 'hit');
      if (hits.length === 0) {
        return finishResult({ nodeId: node.id, status: 'fail', strategies: runs, message: '并行策略全部未命中' });
      }
      hits.sort(
        (a, b) =>
          (b.confidence ?? 0) - (a.confidence ?? 0) || enabled.indexOf(a.key) - enabled.indexOf(b.key),
      );
      const best = hits[0];
      this.context.lastRecognize = { x: best.x!, y: best.y!, nodeId: node.id, strategy: best.key };
      return finishResult({
        nodeId: node.id,
        status: 'ok',
        strategies: runs,
        hitCoords: { x: best.x!, y: best.y! },
        matchBox: best.key === 'template'
          ? runs.find((run) => run.key === 'template' && run.status === 'hit')?.matchBox
          : undefined,
        matchScale: best.key === 'template'
          ? runs.find((run) => run.key === 'template' && run.status === 'hit')?.matchScale
          : undefined,
        strategy: best.key,
        message: `并行命中：${STRATEGY_NAMES[best.key]}（${best.confidence ?? 100}%）`,
      });
    }

    // 级联模式
    for (const key of enabled) {
      const run = await runOne(key);
      runs.push(run);
      emitRunLog(run);
      if (run.status === 'hit') {
        this.context.lastRecognize = { x: run.x!, y: run.y!, nodeId: node.id, strategy: key };
        return finishResult({
          nodeId: node.id,
          status: 'ok',
          strategies: runs,
          hitCoords: { x: run.x!, y: run.y! },
          matchBox: key === 'template' ? run.matchBox : undefined,
          matchScale: key === 'template' ? run.matchScale : undefined,
          strategy: key,
          message: `命中：${STRATEGY_NAMES[key]}（${run.confidence ?? 100}%）`,
        });
      }
    }
    return finishResult({ nodeId: node.id, status: 'fail', strategies: runs, message: '所有策略均未命中，已暂停等待人工处理' });
  }

  private buildVisionOverlay(runs: RecognizeStrategyRun[]): VisionOverlayPayload | undefined {
    const capture = this.context.lastCapture;
    if (!capture || capture.width <= 0 || capture.height <= 0) return undefined;
    const markers: VisionOverlayMarker[] = [];
    for (const run of runs) {
      if (run.matchBox && !run.detections?.length) {
        markers.push({ kind: 'box', ...run.matchBox, label: STRATEGY_NAMES[run.key], confidence: run.confidence });
      }
      for (const detection of run.detections ?? []) {
        const [x, y, width, height] = detection.box;
        markers.push({ kind: 'box', x, y, width, height, label: detection.label, confidence: detection.confidence });
      }
      if (!run.matchBox && !run.detections?.length && run.x !== undefined && run.y !== undefined) {
        markers.push({ kind: 'point', x: run.x, y: run.y, label: STRATEGY_NAMES[run.key], confidence: run.confidence });
      }
    }
    return {
      sourceWidth: capture.width,
      sourceHeight: capture.height,
      sourceKind: capture.sourceKind,
      streamSourceId: capture.streamSourceId,
      markers,
    };
  }

  private async runTemplateStrategy(
    frame: string,
    strategy: TemplateStrategyConfig,
  ): Promise<Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>> {
    const index = await loadTemplateIndex();
    const template = strategy.templateId
      ? (index.templates.find((item) => item.id === strategy.templateId) as TemplateDefinition | undefined)
      : null;
    const templatePath = template
      ? join(templateImagesDir(), template.imageFile)
      : (strategy.templatePath ?? null);
    if (!templatePath) return { status: 'error', message: '未选择模板' };
    try {
      await stat(templatePath);
    } catch {
      return { status: 'error', message: '模板文件不存在，可能已被删除' };
    }
    const imagePath = await writeImageToTemp(frame);
    if (!imagePath) return { status: 'error', message: '无法保存待匹配画面' };
    const sourceRect = template?.sourceRect;
    const hotspot = template?.matchHotspot;
    const clickOffset = template?.clickOffset;
    const debugTemplate = [
      `templateId=${template?.id ?? 'manual'}`,
      `templatePath=${templatePath}`,
      `threshold=${strategy.threshold ?? 60}`,
      `sourceRect=${sourceRect ? JSON.stringify(sourceRect) : 'null'}`,
      `hotspot=${hotspot ? JSON.stringify(hotspot) : 'null'}`,
      `clickOffset=${clickOffset ? JSON.stringify(clickOffset) : 'null'}`,
      `templateResolution=${template?.resolution ? `${template.resolution.width}x${template.resolution.height}` : 'unknown'}`,
      `templateScaleFactor=${template?.scaleFactor ?? 'unknown'}`,
      `frameSize=${this.context.lastCapture ? `${this.context.lastCapture.width}x${this.context.lastCapture.height}` : 'unknown'}`,
    ].join(' · ');
    this.emit({ t: 'log', runId: this.runId!, level: 'info', message: `模板调试：${debugTemplate}`, nodeId: undefined });
    const res = await runVisionEngine(
      'template',
      {
        imagePath,
        templatePath,
        threshold: strategy.threshold ?? 60,
        sourceRect,
        hotspot,
        clickOffset,
        debugImagePath: process.env.NODE_ENV === 'development' ? join(app.getPath('userData'), 'last-template-debug.png') : undefined,
      },
      30000,
    );
    if (!res.ok) {
      return { status: 'miss', message: res.message ?? '模板匹配失败' };
    }
    const box = typeof res.x === 'number' && typeof res.y === 'number' && typeof res.width === 'number' && typeof res.height === 'number'
      ? { x: res.x, y: res.y, width: res.width, height: res.height }
      : null;
    const click = typeof res.clickX === 'number' && typeof res.clickY === 'number'
      ? { x: res.clickX, y: res.clickY }
      : null;
    this.emit({
      t: 'log',
      runId: this.runId!,
      level: 'info',
      message: `模板命中详情：box=${box ? JSON.stringify(box) : 'null'} · click=${click ? JSON.stringify(click) : 'null'} · matchScale=${typeof res.matchScale === 'number' ? res.matchScale : 'null'} · confidence=${typeof res.confidence === 'number' ? res.confidence : 'null'} · message=${res.message ?? '模板匹配成功'}`,
      nodeId: undefined,
    });
    return {
      status: 'hit',
      confidence: typeof res.confidence === 'number' ? res.confidence : undefined,
      x: typeof res.clickX === 'number' ? res.clickX : undefined,
      y: typeof res.clickY === 'number' ? res.clickY : undefined,
      matchBox: box ?? undefined,
      matchScale: typeof res.matchScale === 'number' ? res.matchScale : undefined,
      debugImagePath: typeof res.debugImagePath === 'string' ? res.debugImagePath : undefined,
      message: res.message ?? '模板匹配成功',
    };
  }

  private async executeGameplayState(node: GameplayStateNode, generation: number): Promise<NodeRunResult> {
    if (!node.data.modelPath) {
      return { nodeId: node.id, status: 'fail', message: 'Gameplay State 尚未选择 YOLO 模型' };
    }
    if ((node.data.captureMode ?? 'frame') === 'frame') {
      const frame = this.context.lastFrame;
      if (!frame) {
        return { nodeId: node.id, status: 'fail', message: '单帧攻防识别需要先执行 screenshot 节点' };
      }
      return this.detectGameplayStateFrame(node, frame);
    }

    const fps = await this.resolveProcessingFrameRate(node.data.fps, node.data.source ?? 'stream', node.data.streamSourceId);
    const timeoutMs = Math.max(250, node.data.timeoutMs ?? 5000);
    const frameInterval = Math.round(1000 / fps);
    const deadline = Date.now() + timeoutMs;
    const captureNode = {
      id: `${node.id}-capture`,
      type: 'screenshot',
      title: `${node.title} Frame`,
      position: node.position,
      enabled: true,
      data: {
        regionMode: 'full',
        source: node.data.source ?? 'stream',
        streamSourceId: node.data.streamSourceId,
        windowHint: node.data.windowHint,
        windowId: node.data.windowId,
        windowApp: node.data.windowApp,
      },
    } as ScreenshotNode;
    let lastResult: NodeRunResult | null = null;
    while (!this.stopped && this.runGeneration === generation && Date.now() <= deadline) {
      const iterationStartedAt = Date.now();
      const cap = await this.captureNodeImage(captureNode, { jpeg: true });
      if (cap.ok && cap.frame) {
        lastResult = await this.detectGameplayStateFrame(node, cap.frame);
        if (lastResult.gameplayState && lastResult.gameplayState !== 'unknown') return lastResult;
      }
      const remainingFrameTime = frameInterval - (Date.now() - iterationStartedAt);
      if (remainingFrameTime > 0) await sleep(remainingFrameTime);
    }
    return lastResult ?? { nodeId: node.id, status: 'fail', message: `攻防状态检测超时（${timeoutMs}ms）` };
  }

  private async detectGameplayStateFrame(node: GameplayStateNode, frame: string): Promise<NodeRunResult> {
    const modelPath = node.data.modelPath;
    if (!modelPath) {
      return { nodeId: node.id, status: 'fail', message: 'Gameplay State 尚未选择 YOLO 模型' };
    }
    try {
      const detections = await this.runSpatialYolo(frame, modelPath, node.data.modelId, node.data.numClasses, node.data.threshold ?? 60);
      const offense = this.pickDetection(detections, node.data.offenseLabel);
      const defense = this.pickDetection(detections, node.data.defenseLabel);
      let raw: GameplayStateValue = 'unknown';
      if (offense && defense) raw = offense.confidence >= defense.confidence ? 'offense' : 'defense';
      else if (offense) raw = 'offense';
      else if (defense) raw = 'defense';

      const current = this.gameplayStateTrackers[node.id] ?? {
        state: 'unknown',
        candidate: null,
        candidateFrames: 0,
        holdFrames: 0,
      };
      const update = updateGameplayStateTracker(
        current,
        raw,
        node.data.confirmFrames ?? 3,
        node.data.holdFrames ?? 2,
      );
      this.gameplayStateTrackers[node.id] = update.tracker;
      this.context.lastGameplayState = update.tracker.state;
      this.context.lastGameplayStateChanged = update.changed;
      return {
        nodeId: node.id,
        status: 'ok',
        gameplayState: update.tracker.state,
        gameplayStateRaw: raw,
        gameplayStateChanged: update.changed,
        message: `攻防状态：${update.tracker.state}（本帧 ${raw}${update.changed ? '，状态切换' : ''}）`,
      };
    } catch (err) {
      return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async executeSpatialDetector(node: SpatialDetectorNode, generation: number): Promise<NodeRunResult> {
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.emit({ t: 'log', runId: this.runId!, level, message, nodeId: node.id });
    if (!node.data.modelPath) {
      return { nodeId: node.id, status: 'fail', message: 'Spatial Detector 尚未选择 YOLO 模型' };
    }

    const captureMode = node.data.captureMode ?? 'live';
    if (captureMode === 'frame') {
      const frame = this.context.lastFrame;
      if (!frame) {
        return { nodeId: node.id, status: 'fail', message: '单帧模式需要先执行 screenshot 节点' };
      }
      return this.detectSpatialFrame(node, frame, true, false, this.context.lastCapture ? {
        width: this.context.lastCapture.width,
        height: this.context.lastCapture.height,
        sourceKind: this.context.lastCapture.sourceKind,
        streamSourceId: this.context.lastCapture.streamSourceId,
      } : undefined);
    }

    const fps = await this.resolveProcessingFrameRate(
      node.data.fps,
      node.data.source ?? 'stream',
      node.data.streamSourceId,
    );
    const timeoutMs = Math.max(250, node.data.timeoutMs ?? 5000);
    const frameInterval = Math.round(1000 / fps);
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let processedFrames = 0;
    const processingMetrics = () => ({
      targetFps: fps,
      processingFps: Math.round(processedFrames / Math.max(0.001, (Date.now() - startedAt) / 1000)),
      processingFrameCount: processedFrames,
    });
    log('info', `空间检测：来源 ${node.data.source ?? 'stream'}，处理帧率上限 ${fps} FPS，${timeoutMs}ms 启动超时`);
    const captureNode = {
      id: `${node.id}-capture`,
      type: 'screenshot',
      title: `${node.title} Frame`,
      position: node.position,
      enabled: true,
      data: {
        regionMode: 'full',
        source: node.data.source ?? 'stream',
        streamSourceId: node.data.streamSourceId,
        windowHint: node.data.windowHint,
        windowId: node.data.windowId,
        windowApp: node.data.windowApp,
      },
    } as ScreenshotNode;
    let lastMessage = '尚未取得有效画面';
    while (!this.stopped && this.runGeneration === generation) {
      const hasPartialObservation = Boolean(
        this.spatialObservations[node.id]?.player || this.spatialObservations[node.id]?.target,
      );
      if (!hasPartialObservation && Date.now() > deadline) break;
      const iterationStartedAt = Date.now();
      const cap = await this.captureNodeImage(captureNode, { jpeg: true });
      if (cap.ok && cap.frame) {
        const result = await this.detectSpatialFrame(node, cap.frame, true, false, {
          width: cap.width ?? 0,
          height: cap.height ?? 0,
          sourceKind: cap.sourceKind,
          streamSourceId: cap.streamSourceId,
        });
        processedFrames += 1;
        if (result.status === 'ok' && result.spatialReady) {
          const integratedMove = this.findDirectContinuousMovePlayer(node);
          if (integratedMove) {
            log('info', `空间检测已获得空间关系，进入 ${integratedMove.title || integratedMove.id} 持续闭环`);
            const moveResult = await this.executeMovePlayer(integratedMove, generation);
            return {
              ...moveResult,
              nodeId: node.id,
              moveIntegrated: true,
              ...processingMetrics(),
            };
          }
          return { ...result, ...processingMetrics() };
        }
        lastMessage = result.message ?? lastMessage;
      } else {
        lastMessage = cap.message ?? lastMessage;
      }
      const remainingFrameTime = frameInterval - (Date.now() - iterationStartedAt);
      if (remainingFrameTime > 0) await sleep(remainingFrameTime);
    }
    const observations = this.spatialObservations[node.id] ?? {};
    if (observations.player || observations.target) {
      return {
        ...createPartialSpatialResult(
          node.id,
          observations,
          node.data.playerLabel,
          node.data.targetLabel,
        ),
        message: '只观察到一个目标，已跨帧保留并继续等待另一个目标',
        ...processingMetrics(),
      };
    }
    return {
      nodeId: node.id,
      status: 'fail',
      message: `实时空间检测启动超时（${timeoutMs}ms）：Player 和 Target 均未出现；${lastMessage}`,
      ...processingMetrics(),
    };
  }

  private async detectSpatialFrame(node: SpatialDetectorNode, frame: string, logResult = true, requireSameFrame = false, capture?: SpatialCaptureContext): Promise<NodeRunResult> {
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.emit({ t: 'log', runId: this.runId!, level, message, nodeId: node.id });
    const modelPath = node.data.modelPath;
    if (!modelPath) {
      return { nodeId: node.id, status: 'fail', message: 'Spatial Detector 尚未选择 YOLO 模型' };
    }

    try {
      const detections = await this.runSpatialYolo(
        frame,
        modelPath,
        node.data.modelId,
        node.data.numClasses,
        node.data.threshold ?? 60,
      );
      const targetMode = node.data.targetMode ?? 'detection';
      if (targetMode === 'polyline') {
        const polyline = node.data.targetPolyline ?? [];
        if (polyline.length < 2) {
          return { nodeId: node.id, status: 'fail', message: 'Polyline 目标至少需要两个点' };
        }
        const playerDetection = this.pickDetection(detections, node.data.playerLabel);
        if (!playerDetection) {
          this.emitSpatialOverlay(node, capture, detections);
          return {
            nodeId: node.id,
            status: 'ok',
            partial: true,
            spatialReady: false,
            message: '等待 Player 检测结果',
          };
        }
        this.spatialObservations[node.id] = {
          player: { detection: playerDetection, seenAt: Date.now() },
        };
        const playerImage = this.getDetectionAnchor(playerDetection, node.data.playerAnchor, node.data.playerKeypoint);
        if (!playerImage) {
          return { nodeId: node.id, status: 'fail', message: 'Player 配置为关键点锚点，但模型结果没有可用关键点' };
        }
        const targetImage = closestPointOnPolyline(playerImage, polyline);
        return this.buildSpatialResult(node, playerDetection, undefined, playerImage, targetImage, targetMode, logResult, capture, detections);
      }
      const update = updateSpatialObservations(
        this.spatialObservations[node.id] ?? {},
        detections,
        node.data.playerLabel,
        node.data.targetLabel,
        Date.now(),
      );
      this.spatialObservations[node.id] = update.store;
      const summary = summarizeSpatialObservations(
        update.store,
        node.data.playerLabel,
        node.data.targetLabel,
      );
      if (!update.ready || (requireSameFrame && !(update.sawPlayer && update.sawTarget))) {
        this.emitSpatialOverlay(node, capture, detections);
        log('info', `空间检测跨帧缓存：${summary}`);
        return {
          ...createPartialSpatialResult(
            node.id,
            update.store,
            node.data.playerLabel,
            node.data.targetLabel,
          ),
          spatialProgress: update.sawPlayer || update.sawTarget,
        };
      }
      const playerDetection = update.store.player!.detection;
      const targetDetection = update.store.target!.detection;

      let playerImage: Point2D;
      let targetImage: Point2D;
      if (node.data.targetAnchor === 'boxDistance') {
        const boxDistance = closestPointsBetweenBoxes(playerDetection.box, targetDetection.box);
        playerImage = boxDistance.player;
        targetImage = boxDistance.target;
      } else {
        const playerAnchor = this.getDetectionAnchor(playerDetection, node.data.playerAnchor, node.data.playerKeypoint);
        if (!playerAnchor) {
          return { nodeId: node.id, status: 'fail', message: 'Player 配置为关键点锚点，但模型结果没有可用关键点' };
        }
        playerImage = playerAnchor;
        if (node.data.targetAnchor === 'nearestBoxPoint') {
          targetImage = closestPointOnBox(playerImage, targetDetection.box);
        } else {
          const targetAnchor = this.getDetectionAnchor(targetDetection, node.data.targetAnchor, node.data.targetKeypoint);
          if (!targetAnchor) {
            return { nodeId: node.id, status: 'fail', message: 'Target 配置为关键点锚点，但模型结果没有可用关键点' };
          }
          targetImage = targetAnchor;
        }
      }

      return this.buildSpatialResult(node, playerDetection, targetDetection, playerImage, targetImage, targetMode, logResult, capture, detections);
    } catch (err) {
      this.emitSpatialOverlay(node, capture, []);
      return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private emitSpatialOverlay(
    node: SpatialDetectorNode,
    capture: SpatialCaptureContext | undefined,
    detections: YoloDetection[],
    spatial?: SpatialResult,
  ): VisionOverlayPayload | undefined {
    if (!capture || capture.width <= 0 || capture.height <= 0) return undefined;
    const overlay: VisionOverlayPayload = {
      sourceWidth: capture.width,
      sourceHeight: capture.height,
      sourceKind: capture.sourceKind ?? 'other',
      streamSourceId: capture.streamSourceId,
      markers: buildSpatialOverlayMarkers(detections, spatial),
    };
    this.emit({ t: 'visionOverlay', runId: this.runId!, nodeId: node.id, overlay });
    return overlay;
  }

  private buildSpatialResult(
    node: SpatialDetectorNode,
    playerDetection: YoloDetection,
    targetDetection: YoloDetection | undefined,
    playerImage: Point2D,
    targetImage: Point2D,
    targetMode: 'detection' | 'polyline',
    logResult = true,
    capture?: SpatialCaptureContext,
    detections: YoloDetection[] = [],
  ): NodeRunResult {
    const calibration = node.data.calibration;
    let homography: number[] | null = null;
    if (calibration && (calibration.image.length > 0 || calibration.world.length > 0)) {
      if (calibration.image.length < 4 || calibration.world.length < 4) {
        return { nodeId: node.id, status: 'fail', message: '世界坐标标定至少需要 4 组图像点/世界点对应关系' };
      }
      homography = solveHomography(calibration.image, calibration.world);
      if (!homography) {
        return { nodeId: node.id, status: 'fail', message: '世界坐标标定点退化或无法求解单应矩阵' };
      }
    }

    const playerWorld = homography ? transformPointWithHomography(playerImage, homography) : null;
    const targetWorld = homography ? transformPointWithHomography(targetImage, homography) : null;
    const distance = homography && playerWorld && targetWorld
      ? Math.hypot(targetWorld.x - playerWorld.x, targetWorld.y - playerWorld.y)
      : Math.hypot(targetImage.x - playerImage.x, targetImage.y - playerImage.y);
    const direction = normalizeVector({ x: targetImage.x - playerImage.x, y: targetImage.y - playerImage.y });
    const movement = calculateSpatialMovement(distance, direction, {
      minMagnitude: 0.2,
      maxMagnitude: 0.7,
      deadZone: 0,
      brakeDistance: 120,
    });
    const tolerance = Math.max(0, node.data.arrivalTolerance ?? 0);
    const requiredFrames = Math.max(1, Math.round(node.data.stabilityFrames ?? 1));
    const stableFrames = distance <= tolerance
      ? (this.spatialStableFrames[node.id] ?? 0) + 1
      : 0;
    this.spatialStableFrames[node.id] = stableFrames;
    const arrived = stableFrames >= requiredFrames;
    const spatial: SpatialResult = {
      player: { image: playerImage, world: playerWorld ?? undefined },
      target: { image: targetImage, world: targetWorld ?? undefined },
      distance,
      distanceSpace: homography ? 'world' : 'image',
      direction,
      movement: movement.vector,
      requiredStickMagnitude: movement.magnitude,
      targetMode,
      arrived,
      stableFrames,
      calibrationApplied: Boolean(homography),
      playerBox: playerDetection.box,
      targetBox: targetDetection?.box,
    };
    this.context.lastSpatial = spatial;
    const visionOverlay = this.emitSpatialOverlay(node, capture, detections, spatial);
    const unit = calibration?.unit ?? (homography ? 'world' : 'px');
    if (logResult) this.emit({
      t: 'log',
      runId: this.runId!,
      level: 'info',
      message: `空间检测：player=(${playerImage.x.toFixed(1)}, ${playerImage.y.toFixed(1)}) target=(${targetImage.x.toFixed(1)}, ${targetImage.y.toFixed(1)}) distance=${distance.toFixed(2)}${unit} arrived=${arrived}`,
      nodeId: node.id,
    });
    return {
      nodeId: node.id,
      status: 'ok',
      spatial,
      spatialReady: true,
      hitCoords: playerImage,
      visionOverlay,
      message: `距离 ${distance.toFixed(2)}${unit}，${arrived ? '已到达' : '继续移动'}`,
    };
  }

  private async executeMovePlayer(node: MovePlayerNode, generation: number): Promise<NodeRunResult> {
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.emit({ t: 'log', runId: this.runId!, level, message, nodeId: node.id });

    const controlMode = node.data.controlMode ?? 'continuous';
    if (controlMode === 'pulse') {
      return this.executePulseMovePlayer(node);
    }

    log('info', `Move Player 启动：controlMode=${controlMode}，control=${node.data.control}，target=${node.data.target}，streamSourceId=${node.data.streamSourceId ?? '未设置'}`);
    const detector = this.resolveSpatialDetectorForMove(node);
    if (!detector) {
      const message = '持续移动需要一个 Spatial Detector，请在 Move Player 中选择空间检测节点';
      log('error', message);
      return { nodeId: node.id, status: 'fail', message };
    }
    log('info', `Move Player 使用空间检测节点：${detector.title || detector.id}（${detector.data.playerLabel || 'player'} → ${detector.data.targetLabel || 'target'}）`);

    let controller: MoveInputController;
    try {
      controller = await this.createMoveInputController(node);
      log('info', `Move Player 输入通道已初始化：${node.data.control} / ${node.data.target}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `Move Player 输入通道初始化失败：${message}`);
      return { nodeId: node.id, status: 'fail', message };
    }

    const fps = CONTINUOUS_MOVE_FPS;
    const frameInterval = Math.max(1, Math.round(1000 / fps));
    const stopDistance = Math.max(0, node.data.deadZone ?? 0);
    const startedAt = Date.now();
    const captureNode = {
      id: `${node.id}-capture`,
      type: 'screenshot',
      title: `${node.title} Frame`,
      position: node.position,
      enabled: true,
      data: {
        regionMode: 'full',
        source: detector.data.source ?? 'stream',
        streamSourceId: detector.data.streamSourceId,
        windowHint: detector.data.windowHint,
        windowId: detector.data.windowId,
        windowApp: detector.data.windowApp,
      },
    } as ScreenshotNode;

    let processedFrames = 0;
    let latestSpatial: SpatialResult | null = null;
    let latestDirection: MoveDirection = 'stop';
    let latestVector: Point2D = { x: 0, y: 0 };
    let latestMagnitude = 0;
    let previousDirection: MoveDirection = 'stop';
    let previousReason: string | null = null;
    let lastError: string | null = null;

    const metrics = () => ({
      targetFps: fps,
      processingFps: Math.round(processedFrames / Math.max(0.001, (Date.now() - startedAt) / 1000)),
      processingFrameCount: processedFrames,
      spatial: latestSpatial ?? undefined,
      moveDirection: latestDirection,
      moveVector: latestVector,
      moveMagnitude: latestMagnitude,
    });

    log('info', `Move Player 持续闭环：${fps} FPS，停止距离 ${stopDistance}${detector.data.calibration ? detector.data.calibration.unit ?? 'world' : 'px'}；到达只释放输入，闭环持续到手动停止`);

    try {
      while (!this.stopped && this.runGeneration === generation) {
        if (this.paused !== 'none') {
          await controller.release();
          latestDirection = 'stop';
          latestVector = { x: 0, y: 0 };
          latestMagnitude = 0;
          await this.waitForResumeOrStop(generation);
          continue;
        }
        const iterationStartedAt = Date.now();
        const cap = await this.captureNodeImage(captureNode, { jpeg: true });
        let spatial: SpatialResult | null = null;
        if (!cap.ok || !cap.frame) {
          lastError = cap.message ?? '本帧画面获取失败';
        } else {
          const detected = await this.detectSpatialFrame(detector, cap.frame, false, true, {
            width: cap.width ?? 0,
            height: cap.height ?? 0,
            sourceKind: cap.sourceKind,
            streamSourceId: cap.streamSourceId,
          });
          processedFrames += 1;
          if (detected.status === 'fail') {
            lastError = detected.message ?? '本帧空间检测失败';
          } else {
            spatial = detected.spatialReady ? detected.spatial ?? null : null;
            if (!spatial) lastError = detected.message ?? '本帧没有完整的 Player/Target 空间关系';
          }
        }

        if (spatial) latestSpatial = spatial;
        const decision = decideContinuousMoveFrame(spatial, {
          directionMode: node.data.directionMode,
          direction: node.data.direction,
          stopDistance,
          releaseWhenArrived: Boolean(node.data.stopWhenArrived),
        });
        const applied = await controller.apply(decision.direction, decision.action === 'hold' ? spatial ?? undefined : undefined);
        latestDirection = decision.direction;
        latestVector = applied.vector;
        latestMagnitude = applied.magnitude;

        const changedDecision = decision.direction !== previousDirection || decision.reason !== previousReason;
        if (changedDecision || processedFrames === 1 || processedFrames % Math.max(1, Math.round(fps)) === 0) {
          const distanceLabel = spatial ? `distance=${spatial.distance.toFixed(2)}` : 'distance=不可用';
          log('info', `移动帧 ${processedFrames}：${distanceLabel}，方向=${decision.direction}，${decision.action === 'hold' ? '按住输入' : '释放输入'}，继续监测`);
        }
        previousDirection = decision.direction;
        previousReason = decision.reason;

        const remainingFrameTime = frameInterval - (Date.now() - iterationStartedAt);
        if (remainingFrameTime > 0) await sleep(remainingFrameTime);
      }

      await controller.release();
      return {
        nodeId: node.id,
        status: 'ok',
        ...metrics(),
        moveDirection: 'stop',
        moveVector: { x: 0, y: 0 },
        moveMagnitude: 0,
        message: `持续移动已由手动停止或新运行替代；${lastError ?? '闭环按帧持续执行'}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `Move Player 持续闭环异常，已释放输入：${message}`);
      return {
        nodeId: node.id,
        status: 'fail',
        ...metrics(),
        moveDirection: 'stop',
        moveVector: { x: 0, y: 0 },
        moveMagnitude: 0,
        message,
      };
    } finally {
      await controller.release();
    }
  }

  private findDirectContinuousMovePlayer(node: SpatialDetectorNode): MovePlayerNode | null {
    const nextId = this.nextOf(node.id, 'out');
    const next = nextId ? this.findNode(nextId) : null;
    return next && next.type === 'movePlayer' && (next.data.controlMode ?? 'continuous') === 'continuous'
      ? next
      : null;
  }

  private resolveSpatialDetectorForMove(node: MovePlayerNode): SpatialDetectorNode | null {
    const nodes = this.workflow?.nodes ?? [];
    const detectors = nodes.filter((item): item is SpatialDetectorNode => item.type === 'spatialDetector');
    if (node.data.detectorNodeId) {
      return detectors.find((item) => item.id === node.data.detectorNodeId) ?? null;
    }
    const currentIndex = nodes.findIndex((item) => item.id === node.id);
    const priorDetectors = detectors.filter((item) => {
      const detectorIndex = nodes.findIndex((candidate) => candidate.id === item.id);
      return currentIndex < 0 || detectorIndex < currentIndex;
    });
    return priorDetectors[priorDetectors.length - 1] ?? detectors[detectors.length - 1] ?? null;
  }

  private async createMoveInputController(node: MovePlayerNode): Promise<MoveInputController> {
    let windowHint: string | undefined;
    let windowId: number | undefined;
    let windowApp: string | undefined;
    let profile: StreamSourceProfile | undefined;
    if (node.data.target === 'stream') {
      if (!node.data.streamSourceId) {
        throw new Error('Move Player 使用 stream 目标时必须选择串流设备');
      }
      profile = (await loadStreamSources()).sources.find((source) => source.id === node.data.streamSourceId);
      if (!profile) throw new Error('所选串流设备不存在');
      windowHint = profile.windowHint;
      windowId = profile.windowId;
      windowApp = profile.windowApp;
      if (profile.transport !== 'ps5Direct' && !windowHint && !windowId && !windowApp) {
        throw new Error('所选串流设备尚未配置目标窗口');
      }
    }

    const actionFor = (direction: MoveDirection): string => direction === 'up'
      ? 'pressLU'
      : direction === 'down'
        ? 'pressLD'
        : direction === 'left'
          ? 'pressLL'
          : 'pressLR';
    const keyboardKeyFor = (direction: MoveDirection): string | undefined => node.data.control === 'keyboard'
      ? direction === 'up'
        ? node.data.keyboardUp
        : direction === 'down'
          ? node.data.keyboardDown
          : direction === 'left'
            ? node.data.keyboardLeft
            : node.data.keyboardRight
      : undefined;

    const sendDigitalState = async (direction: Exclude<MoveDirection, 'stop'>, pressed: boolean): Promise<void> => {
      const action = actionFor(direction);
      const keyboardKey = keyboardKeyFor(direction);
      if (node.data.control === 'keyboard' && !keyboardKey) {
        throw new Error(`方向 ${direction} 没有配置键盘按键`);
      }
      if (node.data.control === 'gamepad' && profile?.transport === 'ps5Direct') {
        await getPs5RuntimeClient().sendButton(action, pressed, 0);
        return;
      }
      const res = await runVisionEngine('gamepad', {
        action,
        keyboardKey: keyboardKey || undefined,
        target: node.data.target,
        windowHint,
        windowId,
        windowApp,
        pressed,
        durationMs: 0,
        delayMs: 0,
        pause: 0,
      }, 15000);
      if (!res.ok) throw new Error(res.message ?? `${pressed ? '按下' : '释放'}移动输入失败`);
    };

    const stick = node.data.stick ?? 'left';
    const setAnalog = async (vector: Point2D): Promise<void> => {
      await getPs5RuntimeClient().setStick(stick, vector.x, vector.y);
    };

    let activeDirection: MoveDirection = 'stop';
    let activeVector: Point2D = { x: 0, y: 0 };

    return {
      apply: async (direction, spatial) => {
        if (node.data.control === 'gamepadAnalog') {
          if (node.data.target !== 'stream' || profile?.transport !== 'ps5Direct') {
            throw new Error('模拟摇杆移动需要选择 PS5 Direct 串流设备');
          }
          const manualVector = direction === 'left'
            ? { x: -1, y: 0 }
            : direction === 'right'
              ? { x: 1, y: 0 }
              : direction === 'up'
                ? { x: 0, y: -1 }
                : direction === 'down'
                  ? { x: 0, y: 1 }
                  : { x: 0, y: 0 };
          const movement = spatial
            ? calculateSpatialMovement(spatial.distance, direction === 'stop' ? { x: 0, y: 0 } : spatial.direction, {
                minMagnitude: node.data.minStickMagnitude ?? 0.2,
                maxMagnitude: node.data.maxStickMagnitude ?? 0.7,
                deadZone: node.data.deadZone ?? 0,
                brakeDistance: node.data.brakeDistance ?? 120,
              })
            : { vector: { x: 0, y: 0 }, magnitude: 0 };
          const vector = direction === 'stop'
            ? { x: 0, y: 0 }
            : spatial
              ? movement.vector
              : {
                  x: manualVector.x * (node.data.maxStickMagnitude ?? 0.7),
                  y: manualVector.y * (node.data.maxStickMagnitude ?? 0.7),
                };
          const clamped = {
            x: Math.max(-1, Math.min(1, vector.x)),
            y: Math.max(-1, Math.min(1, vector.y)),
          };
          await setAnalog(clamped);
          activeDirection = direction;
          activeVector = clamped;
          return { vector: clamped, magnitude: Math.hypot(clamped.x, clamped.y) };
        }

        if (direction === activeDirection) {
          // PS5 Direct 的摇杆状态需要按帧刷新；键盘按键保持状态不重复发送。
          if (direction !== 'stop' && node.data.control === 'gamepad' && profile?.transport === 'ps5Direct') {
            await sendDigitalState(direction, true);
          }
          return { vector: activeVector, magnitude: Math.hypot(activeVector.x, activeVector.y) };
        }
        if (activeDirection !== 'stop') {
          await sendDigitalState(activeDirection, false);
        }
        if (direction === 'stop') {
          activeDirection = 'stop';
          activeVector = { x: 0, y: 0 };
          return { vector: activeVector, magnitude: 0 };
        }
        await sendDigitalState(direction, true);
        activeDirection = direction;
        activeVector = direction === 'left'
          ? { x: -1, y: 0 }
          : direction === 'right'
            ? { x: 1, y: 0 }
            : direction === 'up'
              ? { x: 0, y: -1 }
              : { x: 0, y: 1 };
        return { vector: activeVector, magnitude: 1 };
      },
      release: async () => {
        if (node.data.control === 'gamepadAnalog') {
          if (profile?.transport === 'ps5Direct' && activeDirection !== 'stop') {
            await setAnalog({ x: 0, y: 0 });
          }
          activeDirection = 'stop';
          activeVector = { x: 0, y: 0 };
          return;
        }
        if (activeDirection !== 'stop') {
          await sendDigitalState(activeDirection, false);
        }
        activeDirection = 'stop';
        activeVector = { x: 0, y: 0 };
      },
    };
  }

  private async executePulseMovePlayer(node: MovePlayerNode): Promise<NodeRunResult> {
    const spatial = this.context.lastSpatial;
    const stopDistance = Math.max(0, node.data.deadZone ?? 0);
    if (spatial && spatial.distance <= stopDistance) {
      return { nodeId: node.id, status: 'ok', moveDirection: 'stop', message: `已进入停止距离 ${stopDistance}，不发送输入` };
    }
    if (node.data.stopWhenArrived && spatial?.arrived) {
      return { nodeId: node.id, status: 'ok', moveDirection: 'stop', message: '目标已到达，不发送输入' };
    }
    let direction = node.data.direction;
    if (node.data.directionMode === 'auto') {
      if (!spatial) {
        return { nodeId: node.id, status: 'fail', message: '自动移动需要先执行 Spatial Detector' };
      }
      direction = directionFromVector(spatial.direction);
    }
    if (direction === 'stop') {
      return { nodeId: node.id, status: 'ok', moveDirection: 'stop', message: '移动方向为 stop，不发送输入' };
    }

    let controller: MoveInputController;
    try {
      controller = await this.createMoveInputController(node);
    } catch (err) {
      return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
    }
    try {
      const applied = await controller.apply(direction, spatial ?? undefined);
      await sleep(Math.max(0, node.data.durationMs ?? 120));
      await controller.release();
      if (node.data.delayMs) await sleep(node.data.delayMs);
      return {
        nodeId: node.id,
        status: 'ok',
        moveDirection: direction,
        moveVector: applied.vector,
        moveMagnitude: applied.magnitude,
        message: `单次移动：${direction}`,
      };
    } catch (err) {
      return { nodeId: node.id, status: 'fail', message: err instanceof Error ? err.message : String(err) };
    } finally {
      await controller.release();
    }
  }

  private async runSpatialYolo(
    frame: string,
    modelPath: string,
    modelId: string | undefined,
    numClasses: number | undefined,
    threshold: number,
  ): Promise<YoloDetection[]> {
    try {
      await stat(modelPath);
    } catch {
      throw new Error('YOLO 模型文件不存在，可能已被删除');
    }
    const index = await loadYoloIndex();
    const model = (modelId
      ? index.models.find((item) => item.id === modelId)
      : index.models.find((item) => modelPath.endsWith(String(item.file)))) as YoloModel | undefined;
    let classNames: string[] = [];
    if (model?.datasetId) {
      const dataset = await loadDatasetFile(String(model.datasetId));
      classNames = dataset.classes.map((item) => item.name);
    }
    const config = {
      modelPath,
      baseModel: (model?.baseModel as string) ?? 'yolox_s',
      numClasses: Math.max(1, Math.round(model?.numClasses ?? numClasses ?? (classNames.length || 2))),
      imageSize: (model?.imageSize as number) ?? 640,
      classNames,
      confThre: Math.max(1, Math.min(100, threshold)) / 100,
      nmsThre: 0.45,
      yoloxPath: await resolveYoloxPath(),
    };
    const sessionKey = JSON.stringify(config);
    if (!this.yoloSession || this.yoloSessionKey !== sessionKey) {
      this.resetYoloSession();
      this.yoloSession = await YoloInferenceSession.start(config);
      this.yoloSessionKey = sessionKey;
    }
    const res = await this.yoloSession.detect(frame, 15000);
    if (!res.ok) throw new Error(res.message ?? 'YOLO 推理失败');
    return (res.detections ?? []) as YoloDetection[];
  }

  private pickDetection(detections: YoloDetection[], label: string): YoloDetection | null {
    const wanted = label.trim();
    const matches = wanted
      ? detections.filter((item) => item.label === wanted || String(item.label) === wanted)
      : detections;
    return matches[0] ?? null;
  }

  private getDetectionAnchor(
    detection: YoloDetection,
    anchor: 'boxCenter' | 'keypoint' | 'nearestBoxPoint',
    keypoint?: string,
  ): Point2D | null {
    const [x, y, width, height] = detection.box;
    if (anchor === 'keypoint' && detection.keypoints?.length) {
      const wanted = keypoint?.trim();
      const point = wanted
        ? detection.keypoints.find((item) => item.id === wanted || item.label === wanted)
        : detection.keypoints[0];
      if (point) return { x: point.x, y: point.y };
    }
    if (anchor === 'keypoint') return null;
    return { x: x + width / 2, y: y + height / 2 };
  }


  private async runYoloStrategy(
    frame: string,
    strategy: YoloStrategyConfig,
  ): Promise<Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>> {
    const index = await loadYoloIndex();
    const model = strategy.modelId
      ? (index.models.find((item) => item.id === strategy.modelId) as YoloModel | undefined)
      : null;
    const modelPath = model ? join(yoloModelsDir(), model.file) : (strategy.modelPath ?? null);
    if (!modelPath) return { status: 'error', message: '未选择 YOLO 模型' };
    try {
      await stat(modelPath);
    } catch {
      return { status: 'error', message: '模型文件不存在，可能已被删除' };
    }
    let classNames: string[] = [];
    if (model?.datasetId) {
      const data = await loadDatasetFile(String(model.datasetId));
      classNames = data.classes.map((cls) => cls.name);
    }
    const imagePath = await writeImageToTemp(frame);
    if (!imagePath) return { status: 'error', message: '无法保存待检测画面' };
    const threshold = Math.max(1, Math.min(100, strategy.threshold ?? 60));
    const res = await runVisionEngine(
      'yolo',
      {
        imagePath,
        modelPath,
        baseModel: (model?.baseModel as string) ?? 'yolox_s',
        numClasses: (model?.numClasses as number) ?? classNames.length,
        classNames,
        imageSize: (model?.imageSize as number) ?? 640,
        confThre: threshold / 100,
        nmsThre: 0.45,
        yoloxPath: await resolveYoloxPath(),
      },
      90000,
    );
    if (!res.ok) return { status: 'miss', message: res.message ?? 'YOLO 推理失败' };

    const detections = (res.detections ?? []) as Array<{
      label: string;
      confidence: number;
      box: [number, number, number, number];
    }>;
    const labelFilter = strategy.label?.trim();
    const picked = labelFilter
      ? (detections.find((det) => det.label === labelFilter) ?? detections[0])
      : detections[0];
    if (!picked) {
      return {
        status: 'miss',
        detections,
        message: labelFilter ? `未检测到目标「${labelFilter}」` : '未检测到任何目标',
      };
    }
    const x = picked.box[0] + picked.box[2] / 2;
    const y = picked.box[1] + picked.box[3] / 2;
    return {
      status: 'hit',
      confidence: picked.confidence,
      x,
      y,
      matchBox: { x: picked.box[0], y: picked.box[1], width: picked.box[2], height: picked.box[3] },
      detections,
      message: `检测到「${picked.label}」${picked.confidence}%`,
    };
  }

  private async runOcrStrategy(
    frame: string,
    strategy: OcrStrategyConfig,
  ): Promise<Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>> {
    const targetText = strategy.text?.trim();
    if (!targetText) return { status: 'error', message: '未设置目标文字' };
    const threshold = Math.max(0, Math.min(100, strategy.threshold ?? 0));
    const engine = strategy.engine ?? 'auto';
    const visionResult = engine === 'auto' || engine === 'macosVision'
      ? await recognizeWithMacosVision(frame, {
          lang: strategy.lang ?? 'auto',
          targetText,
        })
      : null;
    if (visionResult) {
      const hit = findOcrMatch(visionResult.matches, targetText, threshold);
      if (!hit) {
        const normalizedTarget = normalizeOcrText(targetText);
        const bestTextMatch = visionResult.matches.find((match) => normalizeOcrText(match.text).includes(normalizedTarget));
        return {
          status: 'miss',
          message: bestTextMatch
            ? `OCR 找到文字但置信度 ${bestTextMatch.confidence ?? 0}% 低于阈值 ${threshold}%`
            : `OCR 未找到文字「${targetText}」`,
        };
      }
      return {
        status: 'hit',
        confidence: hit.confidence ?? 100,
        x: hit.box.x + hit.box.width / 2,
        y: hit.box.y + hit.box.height / 2,
        message: `macOS Vision 找到「${hit.text.trim()}」`,
      };
    }

    const { createWorker } = await import('tesseract.js');
    const { langPath, gzip } = await ensureOcrLangData();
    const tesseractLang = strategy.lang === 'chi_sim' ? 'eng+chi_sim' : 'eng';
    const worker = await createWorker(tesseractLang, undefined, { langPath, gzip, cachePath: OCR_DATA_DIR() });
    try {
      const recognition = await worker.recognize(frame, undefined, { blocks: true });
      const data = recognition.data as {
        blocks?: Array<{
          paragraphs?: Array<{
            lines?: Array<{
              words?: Array<{
                text?: string;
                confidence?: number;
                bbox?: { x0?: number; y0?: number; x1?: number; y1?: number };
              }>;
            }>;
          }>;
        }>;
      };
      const words = (data.blocks ?? [])
        .flatMap((block) => block.paragraphs ?? [])
        .flatMap((paragraph) => paragraph.lines ?? [])
        .flatMap((line) => line.words ?? []);
      const target = normalizeOcrText(targetText);
      const hit = words.find((word) => {
        const confidence = typeof word.confidence === 'number' ? word.confidence : 100;
        return confidence >= threshold
          && normalizeOcrText(word.text ?? '').includes(target)
          && (word.bbox?.x1 ?? 0) > (word.bbox?.x0 ?? 0);
      });
      if (!hit || !hit.bbox) {
        const textMatch = words.find((word) => normalizeOcrText(word.text ?? '').includes(target));
        return {
          status: 'miss',
          message: textMatch
            ? `OCR 找到文字但置信度 ${textMatch.confidence ?? 0}% 低于阈值 ${threshold}%`
            : `未找到文字「${targetText}」`,
        };
      }
      const x = hit.bbox.x0! + (hit.bbox.x1! - hit.bbox.x0!) / 2;
      const y = hit.bbox.y0! + (hit.bbox.y1! - hit.bbox.y0!) / 2;
      return {
        status: 'hit',
        confidence: typeof hit.confidence === 'number' ? hit.confidence : undefined,
        x,
        y,
        message: `OCR 找到「${hit.text?.trim()}」`,
      };
    } finally {
      await worker.terminate();
    }
  }

  private async runCloudApiStrategy(
    frame: string,
    strategy: CloudApiStrategyConfig,
  ): Promise<Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>> {
    const profileId = strategy.profileId ?? strategy.apiIds?.[0];
    const index = await loadCloudApiIndex();
    const profile = profileId ? index.profiles.find((item) => item.id === profileId) : null;
    const baseUrl = strategy.url?.trim().replace(/\/+$/, '') || profile?.baseUrl.trim().replace(/\/+$/, '');
    if (!profile && !baseUrl) return { status: 'error', message: '未选择云端 API' };
    const apiKey = strategy.apiKey || profile?.apiKey;
    const prompt =
      strategy.prompt?.trim() ||
      profile?.defaultPrompt ||
      '分析这张截图，返回目标位置的 x、y 坐标（JSON 格式 {"x":..,"y":..}）。';
    if (!baseUrl) return { status: 'error', message: '云端 API 地址为空' };
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ prompt, image: frame }),
      });
      const text = await response.text();
      if (!response.ok) return { status: 'miss', message: `云端 API 返回 HTTP ${response.status}` };
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 非 JSON，按纯文本处理
      }
      const coords = this.extractCoordsFrom(parsed, text);
      if (coords) return { status: 'hit', x: coords.x, y: coords.y, message: '云端已返回坐标' };
      return { status: 'miss', message: '云端未返回可解析的坐标' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 从云 API 响应中提取坐标（与主进程 cloudApi:vision 保持一致） */
  private extractCoordsFrom(parsed: unknown, text: string): { x: number; y: number } | null {
    const pick = (value: unknown): { x: number; y: number } | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      if (typeof record.x === 'number' && typeof record.y === 'number') return { x: record.x, y: record.y };
      if (record.coordinates && typeof record.coordinates === 'object') {
        const coords = record.coordinates as Record<string, unknown>;
        if (typeof coords.x === 'number' && typeof coords.y === 'number') return { x: coords.x, y: coords.y };
      }
      if (typeof record.content === 'string') {
        const matched = record.content.match(/(?:x|X)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,，;]\s*(?:y|Y)\s*[:=]\s*(-?\d+(?:\.\d+)?)/);
        if (matched) return { x: Number(matched[1]), y: Number(matched[2]) };
        const parenthesized = record.content.match(/\((-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*\)/);
        if (parenthesized) return { x: Number(parenthesized[1]), y: Number(parenthesized[2]) };
      }
      return null;
    };
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const found = pick(item);
        if (found) return found;
      }
      return null;
    }
    const root = parsed as Record<string, unknown> | null;
    const candidates = [root, root?.result, root?.data, root?.output];
    for (const candidate of candidates) {
      const found = pick(candidate);
      if (found) return found;
    }
    const raw = text.match(/(?:x|X)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*[,，;]\s*(?:y|Y)\s*[:=]\s*(-?\d+(?:\.\d+)?)/);
    return raw ? { x: Number(raw[1]), y: Number(raw[2]) } : null;
  }

  // ===== 表达式求值 =====

  private evalExpression(expr: string): boolean {
    const ctx: EvalContext = {
      last: this.context.lastRecognize,
      lastOk: this.context.lastRecognize !== null,
      frame: this.context.lastFrame !== null,
      spatial: this.context.lastSpatial,
      gameplayState: this.context.lastGameplayState,
      gameplayStateChanged: this.context.lastGameplayStateChanged,
      results: this.nodeResults,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function('ctx', `return !!(${expr});`) as (ctx: EvalContext) => boolean;
    return fn(ctx);
  }

  // ===== 截图 =====

  private async captureNodeImage(
    node: ScreenshotNode,
    options?: { jpeg?: boolean },
  ): Promise<{ ok: boolean; frame?: string; width?: number; height?: number; originX?: number; originY?: number; scaleX?: number; scaleY?: number; displayId?: string; windowId?: number; sourceKind?: VisionOverlaySourceKind; streamSourceId?: string; message?: string }> {
    const thumbnailSize = { width: 1920, height: 1080 };
    const encodeFrame = (image: Electron.NativeImage) => options?.jpeg
      ? `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`
      : image.toDataURL();
    const captureWindowByHint = async (opts: { hintText?: string; windowId?: number; windowApp?: string }, label = '串流窗口') => {
      const thumbnailSize0 = thumbnailSize;
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: thumbnailSize0,
        fetchWindowIcons: false,
      });
      const hint = opts.hintText?.trim().toLowerCase();
      const wantedId = typeof opts.windowId === 'number' ? opts.windowId : undefined;
      const wantedApp = opts.windowApp?.trim().toLowerCase();

      // 1) 优先按锁定的 CGWindowID 精确定位（标题变化也不影响）
      let windowSource =
        wantedId !== undefined
          ? sources.find((item) => new RegExp(`^window:${wantedId}(?::|$)`).test(item.id))
          : undefined;

      // 2) ID 未命中或未锁定，按应用进程名兜底（如 Google Chrome）
      if (!windowSource && wantedApp) {
        windowSource = sources.find((item) => {
          const idMatch = /^window:(\d+)/.exec(item.id);
          if (!idMatch) return false;
          const owner = getMacWindowOwnerById(Number(idMatch[1]));
          return (owner?.trim().toLowerCase() ?? '') === wantedApp;
        });
      }

      // 3) 最后退回标题关键字匹配
      if (!windowSource && hint) {
        windowSource = sources.find((item) => item.name.toLowerCase().includes(hint));
      }

      if (!windowSource || windowSource.thumbnail.isEmpty()) {
        return { ok: false as const, message: `未找到${label}，请确认窗口已打开、窗口选择正确、且未最小化` };
      }
      const size = windowSource.thumbnail.getSize();
      const windowIdMatch = /^window:(\d+)/.exec(windowSource.id);
      const windowId = windowIdMatch ? Number(windowIdMatch[1]) : undefined;
      const bounds = getMacWindowBoundsById(windowId) ?? getMacWindowBoundsByHint(hint);
      // desktopCapturer 的 id 形如 window:<CGWindowID>:<screenID>，用它精确定位同一窗口
      if (!bounds) {
        // 边界拿不到就只保留截图尺寸，点击阶段会输出完整诊断并拒绝盲点
        return {
          ok: true as const,
          frame: encodeFrame(windowSource.thumbnail),
          width: size.width,
          height: size.height,
          originX: 0,
          originY: 0,
          scaleX: 1,
          scaleY: 1,
          windowId,
        };
      }
      return {
        ok: true as const,
          frame: encodeFrame(windowSource.thumbnail),
        width: size.width,
        height: size.height,
        originX: bounds.x,
        originY: bounds.y,
        scaleX: bounds.width / Math.max(1, size.width),
        scaleY: bounds.height / Math.max(1, size.height),
        windowId,
      };
    };
    const captureScreen = async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
        fetchWindowIcons: false,
      });
      const screenSource = sources[0];
      if (!screenSource || screenSource.thumbnail.isEmpty()) {
        return { ok: false as const, message: '无法截取本机屏幕，请确认屏幕录制权限已授权' };
      }
      const size = screenSource.thumbnail.getSize();
      const display = screen.getAllDisplays().find((d) => String(d.id) === String(screenSource.display_id)) ?? screen.getPrimaryDisplay();
      return {
        ok: true as const,
        frame: encodeFrame(screenSource.thumbnail),
        width: size.width,
        height: size.height,
        originX: display.bounds.x,
        originY: display.bounds.y,
        scaleX: display.bounds.width / Math.max(1, size.width),
        scaleY: display.bounds.height / Math.max(1, size.height),
        displayId: String(screenSource.display_id),
      };
    };

    try {
      if (node.data.source === 'window') {
        return await captureWindowByHint(
          { hintText: node.data.windowHint, windowId: node.data.windowId, windowApp: node.data.windowApp },
          '目标窗口',
        );
      }
      if (node.data.source === 'stream') {
        const index = await loadStreamSources();
        const profile = index.sources.find((source) => source.id === node.data.streamSourceId);
        if (!profile) {
          return { ok: false, message: '找不到串流设备配置，请在「串流设备」中先创建并保存设备' };
        }
        if (profile.transport === 'ps5Direct') {
          try {
            const frame = await getPs5RuntimeClient().getFrame();
            return {
              ok: true,
              frame: frame.frame,
              width: frame.width,
              height: frame.height,
              originX: 0,
              originY: 0,
              scaleX: 1,
              scaleY: 1,
              sourceKind: 'ps5Direct',
              streamSourceId: profile.id,
            };
          } catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) };
          }
        }
        if (profile.type === 'local') {
          return profile.windowHint?.trim()
            ? { ...(await captureWindowByHint({ hintText: profile.windowHint }, '本机窗口')), sourceKind: 'other', streamSourceId: profile.id }
            : { ...(await captureScreen()), sourceKind: 'other', streamSourceId: profile.id };
        }
        return {
          ...(await captureWindowByHint({ hintText: profile.windowHint }, '串流窗口')),
          sourceKind: 'other',
          streamSourceId: profile.id,
        };
      }
      return { ...(await captureScreen()), sourceKind: 'other' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
