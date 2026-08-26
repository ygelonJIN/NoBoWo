import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeRunResult, WorkflowEdge, WorkflowNode, WorkflowRunSnapshot } from '@nobowo/core';

const NODE_TYPE_LABELS: Record<string, string> = {
  screenshot: '截图',
  recognize: '识别',
  click: '点击',
  input: '输入',
  wait: '等待',
  scroll: '滚动',
  keyboard: '按键',
  if: '条件',
  loop: '循环',
};
const STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
};
const STRATEGY_LABELS: Record<string, string> = {
  coords: '坐标回放',
  template: '模板匹配',
  yolo: 'YOLO',
  ocr: 'OCR',
  cloudApi: '云端 API',
};
const STRATEGY_ORDER = ['coords', 'template', 'yolo', 'ocr', 'cloudApi'] as const;

function resultSummary(node: WorkflowNode, result?: NodeRunResult): string {
  if (!result) return '尚未执行';
  if (result.message) return result.message;
  if (node.type === 'recognize' && result.hitCoords) return `命中 (${result.hitCoords.x}, ${result.hitCoords.y})`;
  return STATUS_LABELS[mapNodeStatus(result.status)] ?? result.status;
}

function resultDetail(node: WorkflowNode, result?: NodeRunResult): string | null {
  if (!result) return null;
  if (node.type === 'recognize' && result.strategies) {
    const hit = result.strategies.find((item) => item.status === 'hit');
    if (hit) return `${STRATEGY_LABELS[hit.key] ?? hit.key}${hit.confidence !== undefined ? ` · ${hit.confidence}%` : ''}`;
  }
  if (node.type === 'click' && result.hitCoords) {
    const actual = result.actualClickCoords;
    return actual
      ? `截图坐标 (${result.hitCoords.x.toFixed(1)}, ${result.hitCoords.y.toFixed(1)}) · 实际点击 (${actual.x.toFixed(1)}, ${actual.y.toFixed(1)})`
      : `截图坐标 (${result.hitCoords.x}, ${result.hitCoords.y})`;
  }
  if (node.type === 'screenshot' && result.frame) return `${result.width ?? 0} × ${result.height ?? 0}`;
  return null;
}

function mapNodeStatus(s: string): 'pending' | 'running' | 'done' | 'failed' | 'skipped' {
  if (s === 'ok') return 'done';
  if (s === 'fail') return 'failed';
  if (s === 'skipped') return 'skipped';
  if (s === 'running') return 'running';
  return 'pending';
}

type Props = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onClose: () => void;
  notice?: { main: string; hint?: string } | null;
  workflowState?: WorkflowRunSnapshot | null;
  logs: string[];
};

type ScreenshotEvidence = {
  node: WorkflowNode;
  result: NodeRunResult;
  index: number;
  relatedNodes: WorkflowNode[];
  markers: Array<{ x: number; y: number; label: string; kind: 'recognize' | 'click' }>;
  boxes: Array<{ x: number; y: number; width: number; height: number; label: string; scale?: number }>;
};

function orderWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const adjacency = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const edge of edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) {
      adjacency.get(edge.source)!.push(edge.target);
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const result: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(byId.get(id)!);
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  const seen = new Set(result.map((n) => n.id));
  return [...result, ...nodes.filter((n) => !seen.has(n.id))];
}

function getNodeLabel(node: WorkflowNode): string {
  switch (node.type) {
    case 'click':
      return '点击识别到的目标';
    case 'input':
      return node.data.value ? `输入：${node.data.value}` : '空输入';
    case 'wait':
      return node.data.mode === 'delay' ? `延时 ${node.data.delayMs ?? 1000}ms` : '条件等待';
    case 'screenshot':
      return node.data.regionMode === 'full' ? '全屏截图' : '选区截图';
    case 'if':
      return node.data.expression || '条件判断';
    case 'loop':
      return node.data.mode === 'count' ? `循环 ${node.data.count ?? 3} 次` : '条件循环';
    case 'scroll':
      return `滚动 ${node.data.amount}px`;
    case 'keyboard':
      return node.data.keys ? `按键：${node.data.keys}` : '空按键';
    case 'recognize':
      return '识别目标（五级策略栈）';
  }
}

function mapRunStatus(s: string): 'idle' | 'running' | 'paused' | 'done' {
  if (s === 'running' || s === 'resumed') return 'running';
  if (s === 'paused') return 'paused';
  if (s === 'done') return 'done';
  return 'idle';
}

function buildFallbackLogs(workflowState: WorkflowRunSnapshot | null | undefined, steps: WorkflowNode[]): string[] {
  if (!workflowState) return [];
  const lines: string[] = [];
  const time = new Date().toLocaleTimeString();
  lines.push(`[${time}] 工作流状态：${workflowState.status}`);
  for (const step of steps) {
    const state = workflowState.nodeStates?.[step.id];
    if (!state) continue;
    const result = workflowState.nodeResults?.[step.id];
    const msg = result?.message ?? state;
    lines.push(`[${time}] ${step.title} → ${msg}`);
  }
  return lines;
}

export function DebugPanel({ nodes, edges, onClose, notice, workflowState, logs }: Props) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [expandedShotIndex, setExpandedShotIndex] = useState<number | null>(null);

  const steps = useMemo(() => orderWorkflow(nodes, edges), [nodes, edges]);

  // Derive ALL display state from real workflowState
  const status = mapRunStatus(workflowState?.status ?? 'idle');
  const stepStates: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'> = useMemo(() => {
    const s: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'> = {};
    if (workflowState?.nodeStates) {
      for (const [id, st] of Object.entries(workflowState.nodeStates)) {
        s[id] = mapNodeStatus(st);
      }
    }
    return s;
  }, [workflowState?.nodeStates]);

  const runResults = workflowState?.nodeResults ?? {};
  const screenshotRecords = useMemo(() => {
    return steps.flatMap((node, index) => {
      const result = runResults[node.id];
      return node.type === 'screenshot' && result?.frame ? [{ node, result, index }] : [];
    });
  }, [runResults, steps]);
  const screenshotEvidence = useMemo(() => {
    return screenshotRecords.map((shot, shotIndex) => {
      const nextIndex = screenshotRecords[shotIndex + 1]?.index ?? steps.length;
      const relatedNodes = steps.slice(shot.index + 1, nextIndex).filter((node) => node.type === 'recognize' || node.type === 'click');
      const markers = relatedNodes.flatMap((node) => {
        const result = runResults[node.id];
        if (!result) return [];
        const coords = result.hitCoords;
        return coords
          ? [{
              x: coords.x,
              y: coords.y,
              label: `${node.title} · ${NODE_TYPE_LABELS[node.type] ?? node.type}`,
              kind: node.type === 'click' ? 'click' as const : 'recognize' as const,
            }]
          : [];
      });
      const boxes = relatedNodes.flatMap((node) => {
        const result = runResults[node.id];
        const box = result?.matchBox;
        const scale = result?.matchScale;
        return box
          ? [{
              ...box,
              label: `${node.title} · 模板框`,
              scale,
            }]
          : [];
      });
      return { ...shot, relatedNodes, markers, boxes } as ScreenshotEvidence;
    });
  }, [runResults, screenshotRecords, steps]);
  const recognizeEntries = useMemo(() => {
    return steps.flatMap((node, index) => {
      const result = runResults[node.id];
      return node.type === 'recognize' && result ? [{ node, result, index }] : [];
    });
  }, [runResults, steps]);
  const clickEntries = useMemo(() => {
    return steps.flatMap((node, index) => {
      const result = runResults[node.id];
      return node.type === 'click' && result ? [{ node, result, index }] : [];
    });
  }, [runResults, steps]);
  const currentStepId = useMemo(() => {
    if (!workflowState) return null;
    const runningId = steps.find((n) => workflowState.nodeStates[n.id] === 'running')?.id ?? null;
    if (runningId) return runningId;
    // If paused, find the failed node
    if (workflowState.status === 'paused') {
      return [...steps].reverse().find((n) => workflowState.nodeStates[n.id] === 'fail')?.id ?? null;
    }
    return null;
  }, [workflowState, steps]);

  const currentStep = steps.find((n) => n.id === currentStepId) ?? null;

  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  // Auto-scroll timeline to current step
  useEffect(() => {
    if (!currentStepId) return;
    const el = timelineRef.current?.querySelector(`[data-step="${currentStepId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentStepId]);


  const doneCount = Object.values(stepStates).filter((s) => s === 'done' || s === 'skipped').length;
  const totalCount = steps.length;
  const progress = totalCount === 0 ? 0 : Math.round((doneCount / totalCount) * 100);
  const runningCount = Object.values(stepStates).filter((s) => s === 'running').length;

  const statusLabel: Record<string, string> = {
    idle: '未运行',
    running: '运行中',
    paused: '已暂停',
    done: '已完成',
    stopped: '已停止',
    error: '错误',
  };

  const stepStatusLabel: Record<string, string> = {
    pending: '待执行',
    running: '运行中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
  };

  const expandedEvidence = expandedShotIndex !== null ? screenshotEvidence[expandedShotIndex] ?? null : null;
  const shotLabel = expandedEvidence?.node.title ?? '截图';
  const expandedFrame = expandedEvidence?.result.frame ?? null;
  const expandedSize = expandedEvidence
    ? { width: expandedEvidence.result.width ?? 0, height: expandedEvidence.result.height ?? 0 }
    : null;
  const summaryRows = steps.map((node, index) => {
    const result = runResults[node.id];
    const state = stepStates[node.id] ?? 'pending';
    return {
      node,
      index,
      state,
      result,
      summary: resultSummary(node, result),
      detail: resultDetail(node, result),
    };
  });
  return (
    <div
      className="debug-panel"
      role="dialog"
      aria-modal="false"
      aria-label="调试面板"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="debug-panel__header">
        <div className="debug-panel__title-row">
          <h2>调试面板</h2>
          <span className={`debug-panel__status debug-panel__status--${status}`}>{statusLabel[status]}</span>
        </div>
        <div className="debug-panel__header-actions">
          <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
        </div>
      </header>

      <div className="debug-panel__controls">
        {notice && (
          <div className="debug-panel__notice" role="alert">
            <div className="debug-panel__notice-main">{notice.main}</div>
            {notice.hint && <div className="debug-panel__notice-hint">{notice.hint}</div>}
          </div>
        )}
        <div className="debug-panel__progress">
          <div className="debug-panel__progress-track">
            <div className="debug-panel__progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="debug-panel__progress-text">{progress}% · {doneCount}/{totalCount}</span>
        </div>
      </div>

      {/* Current step banner */}
      <div className="debug-panel__current">
        <span className="debug-panel__current-label">当前步骤</span>
        {currentStep ? (
          <>
            <span className="debug-panel__current-name">{steps.indexOf(currentStep) + 1}. {currentStep.title}</span>
            <span className={`debug-panel__step-status debug-panel__step-status--${stepStates[currentStep.id] ?? 'pending'}`}>
              {stepStatusLabel[stepStates[currentStep.id] ?? 'pending']}
            </span>
          </>
        ) : (
          <span className="debug-panel__current-name debug-panel__current-name--empty">
            {status === 'idle' ? '尚未运行' : '—'}
          </span>
        )}
        {runningCount > 0 && <span className="debug-panel__running-indicator" aria-hidden="true" />}
      </div>

      {/* Timeline */}
      <div className="debug-panel__timeline" ref={timelineRef}>
        <div className="debug-panel__section-title">步骤</div>
        <div className="debug-panel__step-list">
          {steps.map((node, index) => {
            const state = stepStates[node.id] ?? 'pending';
            const isCurrent = node.id === currentStepId;
            const result = runResults[node.id];
            return (
              <div
                key={node.id}
                data-step={node.id}
                className={`debug-panel__step ${isCurrent ? 'debug-panel__step--current' : ''} ${state === 'failed' ? 'debug-panel__step--failed' : ''} ${!node.enabled ? 'debug-panel__step--node-disabled' : ''}`}
              >
                <span className={`debug-panel__step-dot debug-panel__step-dot--${state}`} aria-hidden="true" />
                <span className="debug-panel__step-index">{index + 1}</span>
                <span className="debug-panel__step-main">
                  <span className="debug-panel__step-title">
                    {node.title}
                    {state === 'failed' && <span className="debug-panel__step-failed-icon"> ✗</span>}
                  </span>
                  <span className="debug-panel__step-type">{node.type}{node.enabled === false ? ' · 已停用' : ''}</span>
                </span>
                {state === 'done' && result && (
                  <span className="debug-panel__step-elapsed">{result.elapsedMs}ms</span>
                )}
                <span className={`debug-panel__step-status debug-panel__step-status--${state}`}>
                  {stepStatusLabel[state]}
                </span>
              </div>
            );
          })}
          {steps.length === 0 && <div className="debug-panel__empty">画布还没有节点</div>}
        </div>
      </div>

      {/* Detail */}
      <section className="debug-panel__detail">
        <div className="debug-panel__section-title">步骤摘要</div>
        <div className="debug-panel__summary-list">
          {summaryRows.map(({ node, index, state, result, summary, detail }) => (
            <div key={node.id} className={`debug-panel__summary-row debug-panel__summary-row--${state}`}>
              <span className="debug-panel__summary-index">{index + 1}</span>
              <div className="debug-panel__summary-main">
                <div className="debug-panel__summary-title">
                  <strong>{node.title}</strong>
                  <span className="debug-panel__summary-type">{NODE_TYPE_LABELS[node.type] ?? node.type}</span>
                  <span className={`debug-panel__step-status debug-panel__step-status--${state}`}>{STATUS_LABELS[state]}</span>
                </div>
                <div className="debug-panel__summary-message">{summary}</div>
                {detail && <div className="debug-panel__summary-detail">{detail}</div>}
              </div>
              {result?.elapsedMs !== undefined && <span className="debug-panel__summary-time">{result.elapsedMs}ms</span>}
            </div>
          ))}
          {summaryRows.length === 0 && <div className="debug-panel__empty">画布还没有节点</div>}
        </div>
      </section>

      <div className="debug-panel__shots">
        <div className="debug-panel__section-title">截图证据</div>
        <div className="debug-panel__shot-grid">
          {screenshotEvidence.map((shot, index) => (
            <button className="debug-panel__shot-card" key={shot.node.id} onClick={() => setExpandedShotIndex(index)} title="点击放大">
              <div className="debug-panel__shot-card-title">{shot.node.title}</div>
              <div className="debug-panel__shot-card-stack">
                <img src={shot.result.frame} alt={`${shot.node.title}截图`} className="debug-panel__shot-card-img" />
                {(shot.markers.length > 0 || shot.boxes.length > 0) && (
                <div className="debug-panel__shot-card-overlay">
                  {shot.markers.map((m, markerIndex) => (
                    <span
                      key={markerIndex}
                      className={`debug-panel__shot-card-marker debug-panel__shot-card-marker--${m.kind}`}
                      style={{
                        left: `${Math.max(0, Math.min(100, m.x / Math.max(shot.result.width ?? 1, 1) * 100))}%`,
                        top: `${Math.max(0, Math.min(100, m.y / Math.max(shot.result.height ?? 1, 1) * 100))}%`,
                      }}
                      title={`${m.label} (${m.x.toFixed(1)}, ${m.y.toFixed(1)})`}
                    />
                  ))}
                </div>
              )}
              </div>
              {(shot.markers.length > 0 || shot.boxes.length > 0) && (
                <div className="debug-panel__shot-card-meta">
                  {shot.boxes.length} 个匹配框 · {shot.markers.length} 个识别/点击标记
                  {shot.boxes.length > 0 && shot.boxes[0]?.scale !== undefined && (
                    <span className="debug-panel__shot-card-scale"> · 匹配倍率 {shot.boxes[0].scale.toFixed(2)}x</span>
                  )}
                </div>
              )}
            </button>
          ))}
          {screenshotEvidence.length === 0 && <div className="debug-panel__shot-card-empty">暂无截图证据</div>}
        </div>
      </div>


      {/* Engine logs */}
      <div className="debug-panel__logs">
        <button className="debug-panel__logs-head" onClick={() => setLogsOpen((open) => !open)}>
          <span className="debug-panel__section-title">引擎日志</span>
          <span className="debug-panel__logs-meta">
            <span className="debug-panel__logs-count">{logs.length || buildFallbackLogs(workflowState, steps).length} 条</span>
            <span className={`debug-panel__logs-chevron ${logsOpen ? 'debug-panel__logs-chevron--open' : ''}`}>▾</span>
          </span>
        </button>
        {logsOpen && (
          <div className="debug-panel__log-list">
            {(logs.length > 0 ? logs : buildFallbackLogs(workflowState, steps)).map((line, index) => (
              <div key={index} className="debug-panel__log-line">{line}</div>
            ))}
            {logs.length === 0 && buildFallbackLogs(workflowState, steps).length === 0 && (
              <div className="debug-panel__log-empty">运行后这里会显示引擎的详细执行过程</div>
            )}
          </div>
        )}
      </div>

      {/* Shot viewer */}
      {expandedShotIndex !== null && (
        <div className="debug-panel__shot-viewer" onClick={() => setExpandedShotIndex(null)}>
          <div className="debug-panel__shot-viewer-inner debug-panel__shot-viewer-inner--large" onClick={(e) => e.stopPropagation()}>
            <div className="debug-panel__shot-viewer-head">
              <div className="debug-panel__shot-viewer-head-main">
                <span className="debug-panel__shot-viewer-head-title">{shotLabel}</span>
                {expandedEvidence && (
                  <span className="debug-panel__shot-viewer-head-meta">
                    {expandedEvidence.boxes.length} 个匹配框 · {expandedEvidence.markers.length} 个识别/点击标记
                    {expandedEvidence.boxes.length > 0 && expandedEvidence.boxes[0]?.scale !== undefined && (
                      <span className="debug-panel__shot-viewer-head-scale"> · 匹配倍率 {expandedEvidence.boxes[0].scale.toFixed(2)}x</span>
                    )}
                  </span>
                )}
              </div>
              <button className="template-modal__close" onClick={() => setExpandedShotIndex(null)} aria-label="关闭">×</button>
            </div>
            <div className="debug-panel__shot-viewer-canvas debug-panel__shot-viewer-canvas--large">
              {expandedFrame ? (
                <div className="debug-panel__shot-viewer-stage">
                  <img
                    src={expandedFrame}
                    alt={`${expandedEvidence?.node.title ?? '截图'}放大图`}
                    className="debug-panel__shot-viewer-img"
                  />
                  {expandedEvidence?.boxes.map((box, index) => (
                    <div
                      key={`box-${index}`}
                      className="debug-panel__shot-viewer-box"
                      style={{
                        left: `${box.x / Math.max(expandedSize?.width ?? 1, 1) * 100}%`,
                        top: `${box.y / Math.max(expandedSize?.height ?? 1, 1) * 100}%`,
                        width: `${box.width / Math.max(expandedSize?.width ?? 1, 1) * 100}%`,
                        height: `${box.height / Math.max(expandedSize?.height ?? 1, 1) * 100}%`,
                      }}
                      title={`${box.label} · 匹配倍率 ${box.scale !== undefined ? box.scale.toFixed(2) : '1.00'}x`}
                    />
                  ))}
                  {expandedEvidence?.markers.map((m, index) => (
                    <div
                      key={`marker-${index}`}
                      className={`debug-panel__shot-viewer-marker debug-panel__shot-viewer-marker--${m.kind}`}
                      style={{
                        left: `${Math.max(0, Math.min(100, m.x / Math.max(expandedSize?.width ?? 1, 1) * 100))}%`,
                        top: `${Math.max(0, Math.min(100, m.y / Math.max(expandedSize?.height ?? 1, 1) * 100))}%`,
                      }}
                      title={`${m.label} (${m.x.toFixed(1)}, ${m.y.toFixed(1)})`}
                    />
                  ))}
                </div>
              ) : (
                <div className="debug-panel__shot-viewer-empty">暂无截图</div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}