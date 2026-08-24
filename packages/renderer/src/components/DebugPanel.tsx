import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowEdge, WorkflowNode, WorkflowRunEvent, WorkflowRunSnapshot } from '@nobowo/core';

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
};

type RunStatus = 'idle' | 'running' | 'paused' | 'done';
type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type ShotKey = 'before' | 'after' | 'diff';

type StrategyRunResult = {
  key: string;
  label: string;
  status: 'hit' | 'miss' | 'skipped';
  confidence?: number;
};

type StepRunResult = {
  elapsedMs: number;
  strategies?: StrategyRunResult[];
  hitCoords?: { x: number; y: number };
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

function shouldFailStep(node: WorkflowNode): boolean {
  if (node.type !== 'recognize') return false;
  const strategies = node.data.strategies;
  const order = node.data.strategyOrder ?? STRATEGY_ORDER;
  return !order.some((key) => strategies[key]?.enabled);
}

export function DebugPanel({ nodes, edges, selectedNodeId, onFocusNode, onClose }: Props) {
  const [status, setStatus] = useState<RunStatus>('idle');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [stepStates, setStepStates] = useState<Record<string, StepStatus>>({});
  const [runResults, setRunResults] = useState<Record<string, StepRunResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [expandedShot, setExpandedShot] = useState<ShotKey | null>(null);

  const steps = useMemo(() => orderWorkflow(nodes, edges), [nodes, edges]);
  const selectedStep = steps.find((n) => n.id === selectedStepId) ?? null;
  const currentStep = steps.find((n) => n.id === currentStepId) ?? null;

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const runTimerRef = useRef<number | null>(null);
  const stepStartRef = useRef<Record<string, number>>({});

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

  // Cleanup on unmount
  useEffect(() => () => {
    if (runTimerRef.current) window.clearTimeout(runTimerRef.current);
  }, []);

  const appendLog = useCallback((line: string) => {
    setLogs((current) => [...current.slice(-199), line]);
  }, []);

  const stopRun = useCallback(() => {
    if (runTimerRef.current) window.clearTimeout(runTimerRef.current);
    runTimerRef.current = null;
  }, []);

  const advance = useCallback((fromIndex: number) => {
    if (fromIndex >= steps.length) {
      setStatus('done');
      appendLog(`[${new Date().toLocaleTimeString()}] 运行结束`);
      return;
    }
    const node = steps[fromIndex];

    // Check if this step should fail
    if (shouldFailStep(node)) {
      setCurrentStepId(node.id);
      setStepStates((current) => ({ ...current, [node.id]: 'failed' }));
      setStatus('paused');
      appendLog(`[${new Date().toLocaleTimeString()}] ❌ ${node.title}（${node.type}）失败：无可用的识别策略（全部已停用）`);
      return;
    }

    // Track start time
    stepStartRef.current[node.id] = performance.now();
    setCurrentStepId(node.id);
    setStepStates((current) => ({ ...current, [node.id]: 'running' }));
    appendLog(`[${new Date().toLocaleTimeString()}] 执行 ${node.title}（${node.type}）`);

    const duration = node.type === 'recognize' ? 1100 : 520;

    runTimerRef.current = window.setTimeout(() => {
      const elapsed = Math.round(performance.now() - (stepStartRef.current[node.id] ?? 0));

      // Build step result
      const result: StepRunResult = { elapsedMs: elapsed };
      if (node.type === 'recognize') {
        const strategies = node.data.strategies;
        const order = node.data.strategyOrder ?? STRATEGY_ORDER;
        let hit = false;
        const stratResults: StrategyRunResult[] = [];
        for (const key of order) {
          const s = strategies[key];
          if (!s?.enabled) {
            stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'skipped' });
            continue;
          }
          if (!hit) {
            const threshold = key === 'coords' ? 100 : (s as { threshold?: number }).threshold ?? 60;
            const confidence = key === 'coords' ? 100 : 40 + Math.round(Math.random() * 55);
            if (confidence >= threshold) {
              stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'hit', confidence });
              hit = true;
              result.hitCoords = { x: Math.round(Math.random() * 800 + 200), y: Math.round(Math.random() * 400 + 200) };
            } else {
              stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'miss', confidence });
            }
          } else {
            stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'skipped' });
          }
        }
        result.strategies = stratResults;
        // Log cascade detail
        for (const sr of stratResults) {
          if (sr.status === 'hit') {
            appendLog(`   ${sr.label} 命中 ${sr.confidence}%`);
            appendLog(`   ${sr.label} 未命中（${sr.confidence}% < 阈值）`);
          }
        }
        if (result.hitCoords) {
          appendLog(`   定位坐标 (${result.hitCoords.x}, ${result.hitCoords.y})`);
        }
      }
      setRunResults((current) => ({ ...current, [node.id]: result }));
      setStepStates((current) => ({ ...current, [node.id]: 'done' }));

      runTimerRef.current = window.setTimeout(() => advance(fromIndex + 1), 200);
    }, duration);
  }, [steps, appendLog]);

  const startRun = useCallback(() => {
    stopRun();
    setStepStates({});
    setRunResults({});
    setLogs([]);
    setLogsOpen(true);
    setStatus('running');
    appendLog(`[${new Date().toLocaleTimeString()}] 开始运行（执行引擎未接入，当前为界面预览）`);
    stepStartRef.current = {};
    runTimerRef.current = window.setTimeout(() => advance(0), 260);
  }, [stopRun, advance, appendLog]);

  const toggleRun = useCallback(() => {
    if (status === 'running') {
      stopRun();
      setStatus('paused');
      appendLog(`[${new Date().toLocaleTimeString()}] 已暂停`);
      return;
    }
    if (status === 'paused') {
      const fromIndex = Math.max(0, steps.findIndex((n) => n.id === currentStepId));
      setStatus('running');
      appendLog(`[${new Date().toLocaleTimeString()}] 继续`);
      runTimerRef.current = window.setTimeout(() => advance(fromIndex), 200);
      return;
    }
    startRun();
  }, [status, steps, currentStepId, advance, startRun, stopRun, appendLog]);

  const stopAll = useCallback(() => {
    stopRun();
    setStatus('idle');
    setStepStates({});
    setRunResults({});
    setCurrentStepId(null);
    appendLog(`[${new Date().toLocaleTimeString()}] 已停止`);
  }, [stopRun, appendLog]);

  const retryStep = useCallback(() => {
    if (!currentStep) return;
    stepStartRef.current[currentStep.id] = performance.now();
    setStepStates((current) => ({ ...current, [currentStep.id]: 'running' }));
    setStatus('running');
    appendLog(`[${new Date().toLocaleTimeString()}] 重试 ${currentStep.title}`);

    const duration = currentStep.type === 'recognize' ? 1100 : 520;
    runTimerRef.current = window.setTimeout(() => {
      const elapsed = Math.round(performance.now() - (stepStartRef.current[currentStep.id] ?? 0));
      const result: StepRunResult = { elapsedMs: elapsed };
      if (currentStep.type === 'recognize') {
        const strategies = currentStep.data.strategies;
        const order = currentStep.data.strategyOrder ?? STRATEGY_ORDER;
        let hit = false;
        const stratResults: StrategyRunResult[] = [];
        for (const key of order) {
          const s = strategies[key];
          if (!s?.enabled) {
            stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'skipped' });
            continue;
          }
          if (!hit) {
            const threshold = key === 'coords' ? 100 : (s as { threshold?: number }).threshold ?? 60;
            const confidence = key === 'coords' ? 100 : 40 + Math.round(Math.random() * 55);
            if (confidence >= threshold) {
              stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'hit', confidence });
              hit = true;
              result.hitCoords = { x: Math.round(Math.random() * 800 + 200), y: Math.round(Math.random() * 400 + 200) };
            } else {
              stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'miss', confidence });
            }
          } else {
            stratResults.push({ key, label: STRATEGY_LABELS[key] ?? key, status: 'skipped' });
          }
        }
        result.strategies = stratResults;
        if (!hit) {
          setRunResults((current) => ({ ...current, [currentStep.id]: result }));
          setStepStates((current) => ({ ...current, [currentStep.id]: 'failed' }));
          setStatus('paused');
          appendLog(`[${new Date().toLocaleTimeString()}] ❌ 重试 ${currentStep.title} 仍失败`);
          return;
        }
        for (const sr of stratResults) {
          if (sr.status === 'hit') appendLog(`   ${sr.label} 命中 ${sr.confidence}%`);
          else if (sr.status === 'miss') appendLog(`   ${sr.label} 未命中（${sr.confidence}% < 阈值）`);
        }
        if (result.hitCoords) appendLog(`   定位坐标 (${result.hitCoords.x}, ${result.hitCoords.y})`);
      }
      setRunResults((current) => ({ ...current, [currentStep.id]: result }));
      setStepStates((current) => ({ ...current, [currentStep.id]: 'done' }));
      const fromIndex = Math.max(0, steps.findIndex((n) => n.id === currentStep.id)) + 1;
      runTimerRef.current = window.setTimeout(() => advance(fromIndex), 200);
    }, duration);
  }, [currentStep, steps, advance, appendLog]);

  const skipStep = useCallback(() => {
    if (!currentStep) return;
    setStepStates((current) => ({ ...current, [currentStep.id]: 'skipped' }));
    setStatus('running');
    appendLog(`[${new Date().toLocaleTimeString()}] 跳过 ${currentStep.title}`);
    const fromIndex = Math.max(0, steps.findIndex((n) => n.id === currentStep.id)) + 1;
    runTimerRef.current = window.setTimeout(() => advance(fromIndex), 200);
  }, [currentStep, steps, advance, appendLog]);

  const handleStepClick = useCallback((nodeId: string) => {
    setSelectedStepId(nodeId);
    onFocusNode(nodeId);
  }, [onFocusNode]);

  const doneCount = steps.filter((n) => stepStates[n.id] === 'done').length;
  const progress = steps.length === 0 ? 0 : Math.round((doneCount / steps.length) * 100);
  const runningCount = steps.filter((n) => stepStates[n.id] === 'running').length;

  const statusLabel: Record<RunStatus, string> = {
    idle: '未运行',
    running: '运行中',
    paused: '已暂停',
    done: '已完成',
  };

  const stepStatusLabel: Record<StepStatus, string> = {
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
        <div className="debug-panel__buttons">
          <button className="debug-panel__btn debug-panel__btn--run" onClick={toggleRun} disabled={steps.length === 0}>
            {status === 'running' ? '暂停' : status === 'paused' ? '继续' : '运行'}
          </button>
          <button className="debug-panel__btn" onClick={stopAll} disabled={status === 'idle'}>
            停止
          </button>
        </div>
        <div className="debug-panel__progress">
          <div className="debug-panel__progress-track">
            <div className="debug-panel__progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="debug-panel__progress-text">{progress}% · {doneCount}/{steps.length}</span>
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

      {/* Failure actions */}
      {status === 'paused' && currentStep && stepStates[currentStep.id] === 'failed' && (
        <div className="debug-panel__failure">
          <span className="debug-panel__failure-msg">该步骤执行失败，选择操作：</span>
          <div className="debug-panel__failure-actions">
            <button className="debug-panel__btn debug-panel__btn--retry" onClick={retryStep}>重试</button>
            <button className="debug-panel__btn debug-panel__btn--skip" onClick={skipStep}>跳过</button>
            <button className="debug-panel__btn" onClick={stopAll}>停止</button>
          </div>
        </div>
      )}

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

      {/* Detail: minimal summary + compact recognize chips */}
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
                    const runResult = runResults[selectedStep.id]?.strategies?.find((s) => s.key === key);
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
                  <strong>{runResults[selectedStep.id].elapsedMs}ms</strong>
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

      {/* Engine logs */}
      <div className="debug-panel__logs">
        <button className="debug-panel__logs-head" onClick={() => setLogsOpen((open) => !open)}>
          <span className="debug-panel__section-title">引擎日志</span>
          <span className="debug-panel__logs-meta">
            <span className="debug-panel__logs-count">{logs.length} 条</span>
            <span className={`debug-panel__logs-chevron ${logsOpen ? 'debug-panel__logs-chevron--open' : ''}`}>▾</span>
          </span>
        </button>
        {logsOpen && (
          <div className="debug-panel__log-list">
            {logs.map((line, index) => (
              <div key={index} className="debug-panel__log-line">{line}</div>
            ))}
            {logs.length === 0 && (
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