import { app, desktopCapturer, screen } from 'electron';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type {
  CloudApiProfile,
  LoopNode,
  NodeRunResult,
  NodeRunStatus,
  OcrResult,
  RecognizeNode,
  RecognizeStrategyKey,
  RecognizeStrategyRun,
  ScreenshotNode,
  TemplateDefinition,
  WorkflowDocument,
  WorkflowNode,
  WorkflowRunEvent,
  WorkflowRunHandle,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  YoloModel,
} from '@nobowo/core';
import { runVisionEngine, writeImageToTemp } from './engine';

const STRATEGY_NAMES: Record<RecognizeStrategyKey, string> = {
  coords: '坐标回放',
  template: '模板匹配',
  yolo: 'YOLO',
  ocr: 'OCR',
  cloudApi: '云端 API',
};

// ===== 只读存储辅助（与 main.ts 保持一致；执行引擎运行时只读不写这些数据）=====

const templatesDir = () => join(app.getPath('userData'), 'templates');
const templateIndexFile = () => join(templatesDir(), 'index.json');
const templateImagesDir = () => join(templatesDir(), 'images');

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

async function loadStreamSources(): Promise<{ sources: Array<{ id: string; type: string; windowHint?: string }> }> {
  try {
    const raw = await readFile(streamSourcesFile(), 'utf8');
    const parsed = JSON.parse(raw) as { sources?: unknown[] } | unknown[];
    if (Array.isArray(parsed)) {
      return { sources: parsed as Array<{ id: string; type: string; windowHint?: string }> };
    }
    const obj = parsed as { sources?: unknown[] };
    return { sources: (obj.sources ?? []) as Array<{ id: string; type: string; windowHint?: string }> };
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
  return join(app.getPath('userData'), 'yolox');
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
  lastCapture: {
    source: 'screen' | 'window' | 'stream';
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

type EvalContext = {
  last: { x: number; y: number; nodeId: string; strategy?: RecognizeStrategyKey } | null;
  lastOk: boolean;
  frame: boolean;
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
  private context: RunContext = { lastFrame: null, lastRecognize: null, lastCapture: null };
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
    this.context = { lastFrame: null, lastRecognize: null, lastCapture: null };
    this.nodeStates = {};
    this.nodeResults = {};

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
      return;
    }

    if (this.runGeneration !== generation) return;
    if (this.stopped || this.status === 'stopped') {
      this.status = 'stopped';
      this.emit({ t: 'stopped', runId, message: '工作流已停止' });
      return;
    }
    if (this.status === 'paused') {
      return;
    }

    const failedIds = Object.values(this.nodeResults)
      .filter((result) => result.status === 'fail')
      .map((result) => result.nodeId);
    this.status = 'done';
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
        const expr = node.data.expression?.trim() || 'true';
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
        log('info', `条件「${expr}」为${branch === 'true' ? '真' : '假'}`);
        return { nodeId: node.id, status: 'ok', branch, message: `条件「${expr}」→ ${branch === 'true' ? '真' : '假'}` };
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
        const { keys, mode } = node.data;
        if (!keys) return { nodeId: node.id, status: 'fail', message: '按键内容为空' };
        log('info', `按键：${keys}（${mode}${mode === 'type' ? ` · 间隔 ${node.data.interval ?? 200}ms` : ''}）`);
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
        const { action, target, streamSourceId, streamWindowHint, durationMs, delayMs, useCdp, cdpPort, useSharedMemory } = node.data;
        if (!action) return { nodeId: node.id, status: 'fail', message: '手柄动作为空' };

        log('info', `手柄按键：${action}（目标：${target}${target === 'stream' ? ` → ${streamWindowHint ?? streamSourceId}` : ''}，CDP：${useCdp ? '是' : '否'}，SharedMemory：${useSharedMemory ? '是' : '否'}）`);

        // 获取串流窗口信息
        let windowHint = streamWindowHint;
        if (target === 'stream' && streamSourceId) {
          const index = await loadStreamSources();
          const profile = index.sources.find((s) => s.id === streamSourceId);
          if (profile?.windowHint) {
            windowHint = profile.windowHint;
          }
        }

        const res = await runVisionEngine(
          'gamepad',
          {
            action,
            target,
            streamType: streamSourceId?.includes('xbox') ? 'xbox' : 'ps5',
            windowHint,
            durationMs: durationMs ?? 0,
            delayMs: delayMs ?? 100,
            useCdp: useCdp ?? false,
            cdpPort: cdpPort ?? 9222,
            useSharedMemory: useSharedMemory ?? false,
          },
          15000,
        );

        if (!res.ok) return { nodeId: node.id, status: 'fail', message: res.message ?? '手柄按键失败' };
        return { nodeId: node.id, status: 'ok', message: `手柄按键：${action}` };
      }

      case 'liveVision': {
        const source = node.data.source ?? 'stream';
        const fps = Math.max(1, Math.min(60, node.data.fps ?? 10));
        const timeoutMs = Math.max(500, node.data.timeoutMs ?? 5000);
        const detectMode = node.data.detectMode ?? 'yolo';
        const action = node.data.action ?? 'returnCoords';

        log('info', `实时检测：来源 ${source}，${fps} FPS，${timeoutMs}ms 超时，模式 ${detectMode}`);
        const start = Date.now();
        const frameInterval = Math.round(1000 / fps);
        let frames = 0;
        let hits = 0;
        let latestHit: { x: number; y: number; label?: string; confidence?: number } | null = null;

        const cap = await this.captureNodeImage({ id: `${node.id}-cap`, type: 'screenshot', title: `${node.title} Frame`, position: node.position, enabled: true, data: {
          regionMode: 'full',
          source,
          streamSourceId: node.data.streamSourceId,
          windowHint: node.data.windowHint,
          windowId: node.data.windowId,
          windowApp: node.data.windowApp,
        } } as ScreenshotNode);
        if (!cap.ok || !cap.frame) {
          return { nodeId: node.id, status: 'fail', message: cap.message ?? '实时检测：无法获取画面' };
        }

        while (!this.stopped && this.runGeneration === generation) {
          if (Date.now() - start > timeoutMs) {
            return { nodeId: node.id, status: 'fail', message: `实时检测超时（${timeoutMs}ms）`, liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: latestHit ?? undefined };
          }

          frames += 1;
          let hit: { x: number; y: number; label?: string; confidence?: number } | null = null;

          if (detectMode === 'yolo' || detectMode === 'both') {
            const imagePath = await writeImageToTemp(cap.frame!);
            if (imagePath) {
              const res = await runVisionEngine(
                'yolo',
                {
                  imagePath,
                  modelPath: node.data.yoloModelPath,
                  confThre: (node.data.yoloThreshold ?? 60) / 100,
                  nmsThre: 0.45,
                  classNames: node.data.yoloLabel ? [node.data.yoloLabel] : [],
                },
                20000,
              );
              if (res.ok) {
                const result = res as { detections?: Array<{ label?: string; confidence?: number; box?: [number, number, number, number] }> };
                const det = result.detections?.[0];
                if (det?.box) {
                  const [bx, by, bw, bh] = det.box;
                  hit = { x: bx + bw / 2, y: by + bh / 2, label: det.label, confidence: det.confidence };
                }
              }
            }
          }

          if (hit) {
            hits += 1;
            latestHit = hit;
            const hitLabel = hit.label ? `：${hit.label}` : '';
            const hitConf = typeof hit.confidence === 'number' ? `（${hit.confidence}%）` : '';
            const metrics = { liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: hit };
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

          await sleep(frameInterval);
        }

        return { nodeId: node.id, status: 'fail', message: '实时检测被中止', liveFps: Math.round(frames / Math.max(0.001, (Date.now() - start) / 1000)), liveFrameCount: frames, liveHitCount: hits, liveHitRate: frames > 0 ? hits / frames : 0, liveLatestHit: latestHit ?? undefined };
      }

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

    if (enabled.length === 0) {
      return { nodeId: node.id, status: 'fail', message: '识别节点没有启用任何策略', strategies: runs };
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
        return { nodeId: node.id, status: 'fail', strategies: runs, message: '并行策略全部未命中' };
      }
      hits.sort(
        (a, b) =>
          (b.confidence ?? 0) - (a.confidence ?? 0) || enabled.indexOf(a.key) - enabled.indexOf(b.key),
      );
      const best = hits[0];
      this.context.lastRecognize = { x: best.x!, y: best.y!, nodeId: node.id, strategy: best.key };
      return {
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
      };
    }

    // 级联模式
    for (const key of enabled) {
      const run = await runOne(key);
      runs.push(run);
      emitRunLog(run);
      if (run.status === 'hit') {
        this.context.lastRecognize = { x: run.x!, y: run.y!, nodeId: node.id, strategy: key };
        return {
          nodeId: node.id,
          status: 'ok',
          strategies: runs,
          hitCoords: { x: run.x!, y: run.y! },
          matchBox: key === 'template' ? run.matchBox : undefined,
          matchScale: key === 'template' ? run.matchScale : undefined,
          strategy: key,
          message: `命中：${STRATEGY_NAMES[key]}（${run.confidence ?? 100}%）`,
        };
      }
    }
    return { nodeId: node.id, status: 'fail', strategies: runs, message: '所有策略均未命中，已暂停等待人工处理' };
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
    if (!picked) return { status: 'miss', message: labelFilter ? `未检测到目标「${labelFilter}」` : '未检测到任何目标' };
    const x = picked.box[0] + picked.box[2] / 2;
    const y = picked.box[1] + picked.box[3] / 2;
    return {
      status: 'hit',
      confidence: picked.confidence,
      x,
      y,
      message: `检测到「${picked.label}」${picked.confidence}%`,
    };
  }

  private async runOcrStrategy(
    frame: string,
    strategy: OcrStrategyConfig,
  ): Promise<Omit<RecognizeStrategyRun, 'key' | 'elapsedMs'>> {
    const targetText = strategy.text?.trim();
    if (!targetText) return { status: 'error', message: '未设置目标文字' };
    const { createWorker } = await import('tesseract.js');
    const { langPath, gzip } = await ensureOcrLangData();
    const worker = await createWorker('eng', undefined, { langPath, gzip, cachePath: OCR_DATA_DIR() });
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
      const target = targetText.toLowerCase();
      const hit = words.find(
        (word) => word.text?.trim().toLowerCase().includes(target) && (word.bbox?.x1 ?? 0) > (word.bbox?.x0 ?? 0),
      );
      if (!hit || !hit.bbox) return { status: 'miss', message: `未找到文字「${targetText}」` };
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
      results: this.nodeResults,
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function('ctx', `return !!(${expr});`) as (ctx: EvalContext) => boolean;
    return fn(ctx);
  }

  // ===== 截图 =====

  private async captureNodeImage(
    node: ScreenshotNode,
  ): Promise<{ ok: boolean; frame?: string; width?: number; height?: number; originX?: number; originY?: number; scaleX?: number; scaleY?: number; displayId?: string; windowId?: number; message?: string }> {
    const thumbnailSize = { width: 1920, height: 1080 };
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
          frame: windowSource.thumbnail.toDataURL(),
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
        frame: windowSource.thumbnail.toDataURL(),
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
        frame: screenSource.thumbnail.toDataURL(),
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
        if (profile.type === 'local') {
          return profile.windowHint?.trim()
            ? await captureWindowByHint({ hintText: profile.windowHint }, '本机窗口')
            : await captureScreen();
        }
        return await captureWindowByHint({ hintText: profile.windowHint }, '串流窗口');
      }
      return await captureScreen();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}
