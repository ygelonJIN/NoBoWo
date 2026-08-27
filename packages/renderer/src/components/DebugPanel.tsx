import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NodeRunResult, WorkflowEdge, WorkflowNode, WorkflowRunSnapshot } from '@nobowo/core';
import { TemplateThumb } from './TemplateThumb';

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
const STRATEGY_STATUS_LABELS: Record<string, string> = {
  hit: '命中',
  miss: '未命中',
  error: '出错',
  skipped: '跳过',
};
const MARKER_COLORS = ['#ff4466', '#78a9ff', '#f7c948', '#6ae3a1', '#ff9f43', '#c58bff', '#4dd0e1', '#ff8f8f'];

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
  selectedNodeId?: string | null;
  onFocusNode?: (nodeId: string) => void;
};

type ScreenshotEvidence = {
  node: WorkflowNode;
  result: NodeRunResult;
  index: number;
  relatedNodes: WorkflowNode[];
  markers: Array<{ x: number; y: number; label: string; kind: 'recognize' | 'click'; nodeId: string; color: string }>;
  boxes: Array<{ x: number; y: number; width: number; height: number; label: string; scale?: number; nodeId: string; color: string }>;
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
    case 'wait':
      return node.data.mode === 'delay' ? `延时 ${node.data.delayMs ?? 1000}ms` : '条件等待';
    case 'screenshot':
      return node.data.regionMode === 'full' ? '全屏截图' : '选区截图';
    case 'if':
      return node.data.expression || '条件判断';
    case 'loop':
      return node.data.mode === 'count' ? `循环 ${node.data.count ?? 3} 次` : '条件循环';
    case 'scroll': {
      const presetLabel = node.data.preset === 'small' ? '小幅' : node.data.preset === 'medium' ? '中幅' : node.data.preset === 'large' ? '大幅' : '自定义';
      return `滚动 ${presetLabel}${node.data.preset === 'custom' ? ` ${node.data.customAmount ?? 300}` : ''}`;
    }
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
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);

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
              nodeId: node.id,
              color: MARKER_COLORS[relatedNodes.indexOf(node) % MARKER_COLORS.length],
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
              nodeId: node.id,
              color: MARKER_COLORS[relatedNodes.indexOf(node) % MARKER_COLORS.length],
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

  const summaryRef = useRef<HTMLDivElement | null>(null);

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

  // Auto-scroll summary to current step
  useEffect(() => {
    if (!currentStepId) return;
    const el = summaryRef.current?.querySelector(`[data-summary="${currentStepId}"]`);
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

  const selectedStepIndex = useMemo(
    () => (selectedEvidenceId ? steps.findIndex((n) => n.id === selectedEvidenceId) : -1),
    [selectedEvidenceId, steps],
  );
  const selectedStep = selectedStepIndex >= 0 ? steps[selectedStepIndex] : null;

  // 点击某一步时，找到对应截图证据：本身是截图就用它自己的；否则用它之前最近的一张截图
  const focusedEvidence = useMemo(() => {
    if (!selectedEvidenceId || selectedStepIndex < 0) return null;
    const own = screenshotEvidence.find((e) => e.node.id === selectedEvidenceId) ?? null;
    if (own) return own;
    for (let i = screenshotEvidence.length - 1; i >= 0; i--) {
      if (screenshotEvidence[i].index < selectedStepIndex) return screenshotEvidence[i];
    }
    return null;
  }, [selectedEvidenceId, screenshotEvidence, selectedStepIndex]);

  const evidenceIndexForNode = useCallback(
    (nodeId: string): number | null => {
      const nodeIndex = steps.findIndex((n) => n.id === nodeId);
      if (nodeIndex < 0) return null;
      const ownIndex = screenshotEvidence.findIndex((e) => e.node.id === nodeId);
      if (ownIndex >= 0) return ownIndex;
      for (let i = screenshotEvidence.length - 1; i >= 0; i--) {
        if (screenshotEvidence[i].index < nodeIndex) return i;
      }
      return null;
    },
    [screenshotEvidence, steps],
  );

  const renderNodeDetails = (node: WorkflowNode, result?: NodeRunResult): ReactNode => {
    if (!result) return null;
    if (node.type === 'recognize') {
      if (!result.strategies || result.strategies.length === 0) {
        return <div className="debug-panel__shot-detail-line">{result.message ?? '识别节点未返回策略明细'}</div>;
      }
      return result.strategies.map((run, index) => (
        <div key={`${node.id}-run-${index}`} className={`debug-panel__strategy-run debug-panel__strategy-run--${run.status}`}>
          <span className="debug-panel__strategy-name">{STRATEGY_LABELS[run.key] ?? run.key}</span>
          <span className="debug-panel__strategy-status">{STRATEGY_STATUS_LABELS[run.status] ?? run.status}</span>
          {run.confidence !== undefined && <span className="debug-panel__strategy-conf">置信度 {run.confidence}%</span>}
          {run.matchScale !== undefined && <span className="debug-panel__strategy-scale">匹配倍率 {run.matchScale.toFixed(2)}x</span>}
          {run.matchBox && (
            <span className="debug-panel__strategy-box">
              框 {Math.round(run.matchBox.width)}×{Math.round(run.matchBox.height)} @ ({Math.round(run.matchBox.x)}, {Math.round(run.matchBox.y)})
            </span>
          )}
          {run.elapsedMs !== undefined && <span className="debug-panel__strategy-ms">{run.elapsedMs}ms</span>}
          {run.message && <span className="debug-panel__strategy-msg">{run.message}</span>}
        </div>
      ));
    }
    if (node.type === 'click') {
      const parts: string[] = [];
      if (result.hitCoords) parts.push(`截图坐标 (${result.hitCoords.x.toFixed(1)}, ${result.hitCoords.y.toFixed(1)})`);
      if (result.actualClickCoords) parts.push(`实际点击 (${result.actualClickCoords.x.toFixed(1)}, ${result.actualClickCoords.y.toFixed(1)})`);
      if (result.matchScale !== undefined) parts.push(`匹配倍率 ${result.matchScale.toFixed(2)}x`);
      if (result.matchBox) parts.push(`框 ${Math.round(result.matchBox.width)}×${Math.round(result.matchBox.height)}`);
      if (result.message && parts.length > 0) parts.push(result.message);
      const line = parts.length > 0 ? parts.join(' · ') : result.message ?? '';
      return line ? <div className="debug-panel__shot-detail-line">{line}</div> : null;
    }
    return result.message ? <div className="debug-panel__shot-detail-line">{result.message}</div> : null;
  };
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
  // 截图证据只对识别节点有意义：展示它当时基于的画面、匹配框和使用的模板
  const canViewEvidence = useCallback(
    (nodeId: string): boolean => {
      const node = steps.find((n) => n.id === nodeId);
      if (!node || node.type !== 'recognize') return false;
      return evidenceIndexForNode(nodeId) !== null;
    },
    [evidenceIndexForNode, steps],
  );
  const selectedTemplateId = useMemo(() => {
    if (!selectedStep || selectedStep.type !== 'recognize') return undefined;
    const tpl = selectedStep.data.strategies?.template;
    return tpl?.enabled ? tpl.templateId : undefined;
  }, [selectedStep]);
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

      {/* Detail */}
      <section className="debug-panel__detail" ref={summaryRef}>
        <div className="debug-panel__section-title">步骤摘要</div>
        <div className="debug-panel__summary-list">
          {summaryRows.map(({ node, index, state, result, summary, detail }) => {
            const hasEvidence = canViewEvidence(node.id);
            return (
              <div
                key={node.id}
                data-summary={node.id}
                role={hasEvidence ? 'button' : undefined}
                tabIndex={hasEvidence ? 0 : undefined}
                onClick={() => {
                  if (hasEvidence) setSelectedEvidenceId(node.id);
                }}
                onKeyDown={(e) => {
                  if (hasEvidence && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    setSelectedEvidenceId(node.id);
                  }
                }}
                className={`debug-panel__summary-row debug-panel__summary-row--${state} ${selectedEvidenceId === node.id ? 'debug-panel__summary-row--selected' : ''} ${hasEvidence ? 'debug-panel__summary-row--has-evidence' : ''}`}
              >
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
                <div className="debug-panel__summary-side">
                  {result?.elapsedMs !== undefined && <span className="debug-panel__summary-time">{result.elapsedMs}ms</span>}
                  {hasEvidence && <span className="debug-panel__summary-evidence">查看截图 ›</span>}
                </div>
              </div>
            );
          })}
          {summaryRows.length === 0 && <div className="debug-panel__empty">画布还没有节点</div>}
        </div>
      </section>

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

      {/* Shot viewer（仅识别节点：展示截图、匹配框/点与所用模板） */}
      {selectedEvidenceId !== null && selectedStep?.type === 'recognize' && focusedEvidence && (
        <div className="debug-panel__shot-viewer" onClick={() => setSelectedEvidenceId(null)}>
          <div className="debug-panel__shot-viewer-inner debug-panel__shot-viewer-inner--large" onClick={(e) => e.stopPropagation()}>
            <div className="debug-panel__shot-viewer-head">
              <div className="debug-panel__shot-viewer-head-main">
                <span className="debug-panel__shot-viewer-head-title">
                  {selectedStepIndex + 1}. {selectedStep.title}
                </span>
                <span className="debug-panel__shot-viewer-head-meta">
                  识别时基于「{focusedEvidence.node.title}」画面 · {focusedEvidence.result.width ?? 0}×{focusedEvidence.result.height ?? 0}
                  {' · '}{focusedEvidence.boxes.length} 个匹配框 · {focusedEvidence.markers.length} 个识别/点击点
                </span>
              </div>
              <button className="template-modal__close" onClick={() => setSelectedEvidenceId(null)} aria-label="关闭">×</button>
            </div>
            <div className="debug-panel__shot-viewer-split">
              <div className="debug-panel__shot-viewer-canvas debug-panel__shot-viewer-canvas--large">
                <div className="debug-panel__shot-viewer-stage">
                  <img
                    src={focusedEvidence.result.frame}
                    alt={`${focusedEvidence.node.title}截图`}
                    className="debug-panel__shot-viewer-img"
                  />
                  {focusedEvidence.boxes.map((box, index) => {
                    const isFocus = box.nodeId === selectedEvidenceId;
                    return (
                      <div
                        key={`box-${index}`}
                        className={`debug-panel__shot-viewer-box ${isFocus ? 'debug-panel__shot-viewer-box--focus' : ''}`}
                        style={{
                          left: `${box.x / Math.max(focusedEvidence.result.width ?? 1, 1) * 100}%`,
                          top: `${box.y / Math.max(focusedEvidence.result.height ?? 1, 1) * 100}%`,
                          width: `${box.width / Math.max(focusedEvidence.result.width ?? 1, 1) * 100}%`,
                          height: `${box.height / Math.max(focusedEvidence.result.height ?? 1, 1) * 100}%`,
                          borderColor: box.color,
                          boxShadow: `0 0 10px ${box.color}66`,
                        }}
                        title={`${box.label} · 匹配倍率 ${box.scale !== undefined ? box.scale.toFixed(2) : '1.00'}x`}
                      />
                    );
                  })}
                  {focusedEvidence.markers.map((m, index) => {
                    const isFocus = m.nodeId === selectedEvidenceId;
                    return (
                      <div
                        key={`marker-${index}`}
                        className={`debug-panel__shot-viewer-marker ${isFocus ? 'debug-panel__shot-viewer-marker--focus' : ''}`}
                        style={{
                          left: `${Math.max(0, Math.min(100, m.x / Math.max(focusedEvidence.result.width ?? 1, 1) * 100))}%`,
                          top: `${Math.max(0, Math.min(100, m.y / Math.max(focusedEvidence.result.height ?? 1, 1) * 100))}%`,
                          borderColor: m.color,
                          background: `${m.color}33`,
                          boxShadow: `0 0 10px ${m.color}99`,
                        }}
                        title={`${m.label} (${m.x.toFixed(1)}, ${m.y.toFixed(1)})`}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="debug-panel__shot-viewer-template">
                <div className="debug-panel__shot-detail-title">使用的模板</div>
                {selectedTemplateId ? (
                  <>
                    <div className="debug-panel__shot-viewer-template-frame">
                      <TemplateThumb id={selectedTemplateId} kind="template" className="debug-panel__shot-viewer-template-img" />
                    </div>
                    <div className="debug-panel__shot-viewer-template-meta">
                      该识别节点用此模板做「模板匹配」，命中位置与倍率见下方明细。
                      {(() => {
                        const focusBox = focusedEvidence.boxes.find((b) => b.nodeId === selectedEvidenceId);
                        if (focusBox && typeof focusBox.scale === 'number' && focusBox.scale > 0) {
                          const tw = Math.round(focusBox.width / focusBox.scale);
                          const th = Math.round(focusBox.height / focusBox.scale);
                          return ` 模板原尺寸约 ${tw}×${th}，以 ${focusBox.scale.toFixed(2)}x 匹配 → 红框 ${Math.round(focusBox.width)}×${Math.round(focusBox.height)}，图内红框即模板内容。`;
                        }
                        return '';
                      })()}
                    </div>
                  </>
                ) : (
                  <div className="debug-panel__shot-viewer-template-empty">
                    该识别节点未配置「模板匹配」策略（或模板已被删除），无模板可显示。
                  </div>
                )}
              </div>
            </div>
            <div className="debug-panel__shot-detail">
              <div className="debug-panel__shot-detail-title">识别 / 点击明细</div>
              {focusedEvidence.relatedNodes.map((node, nodeIndex) => {
                const result = runResults[node.id];
                const state = stepStates[node.id] ?? 'pending';
                const color = MARKER_COLORS[nodeIndex % MARKER_COLORS.length];
                return (
                  <div key={node.id} className={`debug-panel__shot-detail-node ${node.id === selectedEvidenceId ? 'debug-panel__shot-detail-node--focus' : ''}`}>
                    <div className="debug-panel__shot-detail-head">
                      <span className="debug-panel__shot-detail-dot" style={{ background: color }} />
                      <strong>{node.title}</strong>
                      <span className="debug-panel__shot-detail-type">{NODE_TYPE_LABELS[node.type] ?? node.type}</span>
                      <span className={`debug-panel__step-status debug-panel__step-status--${state}`}>{STATUS_LABELS[state]}</span>
                    </div>
                    <div className="debug-panel__shot-detail-body">{renderNodeDetails(node, result)}</div>
                  </div>
                );
              })}
              {focusedEvidence.relatedNodes.length === 0 && (
                <div className="debug-panel__shot-detail-empty">这张截图之后没有识别 / 点击步骤</div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}