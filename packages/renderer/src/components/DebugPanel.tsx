import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowEdge, WorkflowNode, WorkflowRunSnapshot } from '@nobowo/core';

const STRATEGY_LABELS: Record<string, string> = {
  coords: '坐标回放',
  template: '模板匹配',
  yolo: 'YOLO',
  ocr: 'OCR',
  cloudApi: '云端 API',
};
const STRATEGY_ORDER = ['coords', 'template', 'yolo', 'ocr', 'cloudApi'] as const;

type Props = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  onFocusNode: (nodeId: string | null) => void;
  onClose: () => void;
  notice?: { main: string; hint?: string } | null;
  workflowState?: WorkflowRunSnapshot | null;
  logs: string[];
};

type ShotKey = 'before' | 'after' | 'diff';

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

function mapNodeStatus(s: string): 'pending' | 'running' | 'done' | 'failed' | 'skipped' {
  if (s === 'ok') return 'done';
  if (s === 'fail') return 'failed';
  if (s === 'skipped') return 'skipped';
  if (s === 'running') return 'running';
  return 'pending';
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

export function DebugPanel({ nodes, edges, selectedNodeId, onFocusNode, onClose, notice, workflowState, logs }: Props) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [expandedShot, setExpandedShot] = useState<ShotKey | null>(null);

  const steps = useMemo(() => orderWorkflow(nodes, edges), [nodes, edges]);
  const selectedStep = steps.find((n) => n.id === selectedStepId) ?? null;

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

  // Sync selectedStepId from canvas node selection
  useEffect(() => {
    if (selectedNodeId && selectedNodeId !== selectedStepId) {
      setSelectedStepId(selectedNodeId);
    }
  }, [selectedNodeId]);

  // Auto-select first step
  useEffect(() => {
    setSelectedStepId((current) => current ?? steps[0]?.id ?? null);
  }, [steps]);

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

  const handleStepClick = useCallback((nodeId: string) => {
    setSelectedStepId(nodeId);
    onFocusNode(nodeId);
  }, [onFocusNode]);

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

  const shotLabels: Record<ShotKey, string> = {
    before: '执行前',
    after: '执行后',
    diff: '变化对比',
  };

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
            const active = node.id === selectedStepId;
            const isCurrent = node.id === currentStepId;
            const result = runResults[node.id];
            return (
              <button
                key={node.id}
                data-step={node.id}
                className={`debug-panel__step ${active ? 'debug-panel__step--active' : ''} ${isCurrent ? 'debug-panel__step--current' : ''} ${state === 'failed' ? 'debug-panel__step--failed' : ''} ${!node.enabled ? 'debug-panel__step--node-disabled' : ''}`}
                onClick={() => handleStepClick(node.id)}
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
              </button>
            );
          })}
          {steps.length === 0 && <div className="debug-panel__empty">画布还没有节点</div>}
        </div>
      </div>

      {/* Detail */}
      <section className="debug-panel__detail">
        <div className="debug-panel__section-title">步骤摘要</div>
        {selectedStep ? (
          <>
            <div className="debug-panel__detail-head">
              <h3>{selectedStep.title}</h3>
              <span className="debug-panel__type-badge">{selectedStep.type}</span>
              <span className={`debug-panel__step-status debug-panel__step-status--${stepStates[selectedStep.id] ?? 'pending'}`}>
                {stepStatusLabel[stepStates[selectedStep.id] ?? 'pending']}
              </span>
            </div>
            <p className="debug-panel__detail-desc">{getNodeLabel(selectedStep)}</p>

            <div className="debug-panel__summary-grid">
              <div className="debug-panel__summary-card">
                <span className="debug-panel__summary-label">执行状态</span>
                <strong>{stepStatusLabel[stepStates[selectedStep.id] ?? 'pending']}</strong>
              </div>
              <div className="debug-panel__summary-card">
                <span className="debug-panel__summary-label">节点类型</span>
                <strong>{selectedStep.type}</strong>
              </div>
              <div className="debug-panel__summary-card">
                <span className="debug-panel__summary-label">启用</span>
                <strong>{selectedStep.enabled !== false ? '是' : '否'}</strong>
              </div>
            </div>

            {selectedStep.type === 'recognize' && (
              <div className="debug-panel__strategy-chips">
                <span className="debug-panel__summary-label">策略栈</span>
                <div className="debug-panel__chips">
                  {(selectedStep.data.strategyOrder ?? STRATEGY_ORDER).map((key, i) => {
                    const strategy = (selectedStep.data.strategies as Record<string, { enabled: boolean; threshold?: number }>)[key];
                    if (!strategy) return null;
                    const runResult = (runResults[selectedStep.id]?.strategies as Array<{ key: string; label?: string; status: string; confidence?: number }>)?.find((s) => s.key === key);
                    const chipClass = runResult
                      ? `debug-panel__chip debug-panel__chip--${runResult.status}`
                      : strategy.enabled
                        ? 'debug-panel__chip debug-panel__chip--enabled'
                        : 'debug-panel__chip debug-panel__chip--disabled';
                    const label = `${i + 1}. ${STRATEGY_LABELS[key] ?? key}`;
                    const detail = runResult
                      ? runResult.status === 'hit'
                        ? `命中 ${runResult.confidence}%`
                        : runResult.status === 'miss'
                          ? `未命中 ${runResult.confidence}%`
                          : '已停用'
                      : strategy.enabled
                        ? `阈值 ${strategy.threshold ?? 60}%`
                        : '已停用';
                    return (
                      <span key={key} className={chipClass} title={detail}>
                        {label}
                        {runResult?.status === 'hit' && ` ✓${runResult.confidence}%`}
                        {runResult?.status === 'miss' && ` ✗${runResult.confidence}%`}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedStep.type === 'recognize' && runResults[selectedStep.id]?.hitCoords && (
              <div className="debug-panel__hit-coords">
                命中坐标 ({runResults[selectedStep.id].hitCoords!.x}, {runResults[selectedStep.id].hitCoords!.y})
              </div>
            )}

            {runResults[selectedStep.id] && (
              <div className="debug-panel__summary-grid">
                <div className="debug-panel__summary-card">
                  <span className="debug-panel__summary-label">耗时</span>
                  <strong>{(runResults[selectedStep.id] as { elapsedMs?: number }).elapsedMs ?? 0}ms</strong>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="debug-panel__empty">选择一个步骤查看摘要</div>
        )}
      </section>

      {/* Screenshot evidence */}
      <div className="debug-panel__shots">
        <div className="debug-panel__section-title">截图对比</div>
        <div className="debug-panel__shot-row">
          {(['before', 'after', 'diff'] as ShotKey[]).map((key) => (
            <button
              key={key}
              className="debug-panel__shot"
              onClick={() => setExpandedShot(key)}
              title="点击查看大图"
            >
              <span className="debug-panel__shot-label">{shotLabels[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Hit point overlay on screenshot */}
      {(() => {
        // 找最近的截图节点，获取 frame
        const screenshotStep = [...steps].reverse().find((n) => n.type === 'screenshot' && runResults[n.id]?.frame);
        const frame = screenshotStep ? runResults[screenshotStep.id]!.frame : null;
        // 找当前选中步骤的命中点（缩略图坐标）
        const hit = selectedStep ? runResults[selectedStep.id]?.hitCoords : null;
        // 找截图节点本身的尺寸
        const shotW = screenshotStep ? (runResults[screenshotStep.id] as { width?: number })?.width : null;
        const shotH = screenshotStep ? (runResults[screenshotStep.id] as { height?: number })?.height : null;
        return frame && hit ? (
          <div className="debug-panel__shot-marker">
            <div className="debug-panel__section-title">命中点</div>
            <div className="debug-panel__shot-marker-frame">
              <img src={frame} alt="截图" className="debug-panel__shot-img" />
              <div
                className="debug-panel__shot-marker-dot"
                style={{
                  left: `${(hit.x / (shotW ?? 1)) * 100}%`,
                  top: `${(hit.y / (shotH ?? 1)) * 100}%`,
                }}
                title={`命中点 (${hit.x}, ${hit.y})`}
              />
            </div>
            <div className="debug-panel__shot-marker-coords">
              命中点 ({hit.x}, {hit.y}) / 截图 {shotW}×{shotH}
            </div>
          </div>
        ) : null;
      })()}

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
      {expandedShot && (
        <div className="debug-panel__shot-viewer" onClick={() => setExpandedShot(null)}>
          <div className="debug-panel__shot-viewer-inner" onClick={(e) => e.stopPropagation()}>
            <div className="debug-panel__shot-viewer-head">
              <span>{shotLabels[expandedShot]}</span>
              <button className="template-modal__close" onClick={() => setExpandedShot(null)} aria-label="关闭">×</button>
            </div>
            <div className="debug-panel__shot-viewer-canvas">截图将在这里展示</div>
          </div>
        </div>
      )}
    </div>
  );
}