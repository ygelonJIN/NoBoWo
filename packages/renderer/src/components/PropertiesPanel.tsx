import type { CloudApiProfile, OcrEngine, RecognizeNode, StreamSourceProfile, StreamWindowInfo, TemplateDefinition, TemplateFolder, WorkflowNode } from '@nobowo/core';
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CustomSelect } from './CustomSelect';
import { ModelPicker } from './ModelPicker';
import { TemplatePicker } from './TemplatePicker';

type Props = {
  node: WorkflowNode | null;
  onChangeNode: (node: WorkflowNode) => void;
  style?: CSSProperties;
  templateVersion: number;
  cloudApiVersion?: number;
  onOpenTemplateManager: () => void;
  onOpenCloudApiManager: () => void;
  onOpenRecognizeTest: () => void;
  yoloVersion?: number;
  onOpenYoloManager?: () => void;
};

type StrategyKey = 'coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi';

const STRATEGY_ORDER: StrategyKey[] = ['coords', 'template', 'yolo', 'ocr', 'cloudApi'];

const STRATEGY_NUMBERS: Record<StrategyKey, number> = {
  coords: 1,
  template: 2,
  yolo: 3,
  ocr: 4,
  cloudApi: 5,
};

const STRATEGY_NAMES: Record<StrategyKey, string> = {
  coords: '坐标回放',
  template: '模板匹配',
  yolo: 'YOLO',
  ocr: 'OCR',
  cloudApi: '云端 API',
};

const OCR_ENGINE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: '系统 OCR（自动）' },
  { value: 'macosVision', label: 'macOS Vision' },
  { value: 'windowsOcr', label: 'Windows OCR' },
  { value: 'tesseract', label: 'Tesseract' },
  { value: 'paddleOcr', label: 'PaddleOCR' },
];

type LooseStrategy = {
  enabled: boolean;
  x?: number;
  y?: number;
  templateId?: string;
  threshold?: number;
  label?: string;
  text?: string;
  engine?: OcrEngine;
  url?: string;
  apiKey?: string;
  prompt?: string;
  modelId?: string;
  modelPath?: string;
  profileId?: string;
  apiIds?: string[];
  apiMode?: 'cascade' | 'parallel';
};

function updateNodeData<T extends WorkflowNode>(node: T, patch: Partial<T['data']>): T {
  return {
    ...node,
    data: {
      ...node.data,
      ...patch,
    },
  };
}

// 键盘录制：优先用物理键码(e.code)，回退用 e.key。
// macOS 上 e.key 受修饰键交换等系统设置影响（物理 ⌘ 可能被报告为 Control），
// 而 e.code 是物理键码（MetaLeft 一定是 command）；但个别环境 e.code 可能缺失，
// 所以 e.key 作为回退通道，保证任何情况下都能捕获到按键。
const RECORD_CODE_MAP: Record<string, string> = {
  MetaLeft: 'command',
  MetaRight: 'command',
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  AltLeft: 'option',
  AltRight: 'option',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'esc',
  Backspace: 'delete',
  Delete: 'del',
  Space: 'space',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
};

const RECORD_KEY_MAP: Record<string, string> = {
  Meta: 'command',
  Control: 'ctrl',
  Alt: 'option',
  Shift: 'shift',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'esc',
  Backspace: 'delete',
  Delete: 'del',
  ' ': 'space',
  Spacebar: 'space',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
};

const RECORD_MODIFIER_ORDER = ['command', 'ctrl', 'option', 'shift', 'fn', 'capslock'];

function sortRecordedCombo(names: string[]): string[] {
  const rest = names.filter((n) => !RECORD_MODIFIER_ORDER.includes(n));
  const mods = names.filter((n) => RECORD_MODIFIER_ORDER.includes(n));
  mods.sort((a, b) => RECORD_MODIFIER_ORDER.indexOf(a) - RECORD_MODIFIER_ORDER.indexOf(b));
  return [...mods, ...rest];
}

function recordKeyPress(e: { code: string; key: string }): { id: string; label: string } | null {
  if (e.code === 'CapsLock' || e.key === 'CapsLock') return null; // 大小写锁定只是状态键
  const codeMapped = RECORD_CODE_MAP[e.code];
  if (codeMapped) return { id: e.code, label: codeMapped };
  const keyMapped = RECORD_KEY_MAP[e.key];
  if (keyMapped) return { id: e.key, label: keyMapped };
  if (e.key.length === 1) return { id: e.code || e.key, label: e.key };
  return null;
}

export function PropertiesPanel({
  node,
  onChangeNode,
  style,
  templateVersion,
  cloudApiVersion = 0,
  onOpenTemplateManager,
  onOpenCloudApiManager,
  onOpenRecognizeTest,
  yoloVersion,
  onOpenYoloManager,
}: Props) {
  const [expandedStrategy, setExpandedStrategy] = useState<StrategyKey | null>(null);
  const [dragUI, setDragUI] = useState<{
    strategy: StrategyKey;
    top: number;
    left: number;
    width: number;
    targetIndex: number | null;
  } | null>(null);
  const dragRef = useRef<{
    strategy: StrategyKey;
    startY: number;
    startTop: number;
    startLeft: number;
    width: number;
    active: boolean;
  } | null>(null);
  const strategiesRef = useRef<HTMLDivElement>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [folders, setFolders] = useState<TemplateFolder[]>([]);
  const [apiProfiles, setApiProfiles] = useState<CloudApiProfile[]>([]);
  const [streamSources, setStreamSources] = useState<StreamSourceProfile[]>([]);
  const [streamSourceLoading, setStreamSourceLoading] = useState(false);
  const [windows, setWindows] = useState<StreamWindowInfo[]>([]);
  const [probingWindows, setProbingWindows] = useState(false);
  const [keyRecording, setKeyRecording] = useState(false);
  const [keyRecordingPresses, setKeyRecordingPresses] = useState<string[]>([]);
  const keyRecordingRef = useRef<{
    labels: Record<string, string>;
    lastCombo: string[];
    timer: number | null;
    finished: boolean;
  } | null>(null);

  const finishKeyRecording = useCallback(
    (combo: string[] | null) => {
      const rec = keyRecordingRef.current;
      if (rec?.timer != null) window.clearTimeout(rec.timer);
      keyRecordingRef.current = null;
      setKeyRecording(false);
      setKeyRecordingPresses([]);
      if (combo && combo.length > 0 && node?.type === 'keyboard') {
        onChangeNode(updateNodeData(node, { keys: combo.join('+') }));
      }
    },
    [node, onChangeNode],
  );

  useEffect(() => {
    if (!keyRecording) return;
    // 判定“松开”：keydown 累积按键并重置长兜底定时器（防 keyup 丢失）；
    // keyup 重置短定时器。任何一次 keyup 到达都会在 ~200ms 后填入，
    // 即使 keyup 的键名与 keydown 不一致也能正常结束（不依赖精确配对）。
    const armTimer = (rec: NonNullable<typeof keyRecordingRef.current>, ms: number) => {
      if (rec.timer != null) window.clearTimeout(rec.timer);
      rec.timer = window.setTimeout(() => {
        const combo = rec.lastCombo;
        rec.finished = true;
        finishKeyRecording(combo.length > 0 ? combo : null);
      }, ms);
    };
    const handlePress = (kind: 'keyDown' | 'keyUp', key: string, code: string) => {
      const rec = keyRecordingRef.current;
      if (!rec || rec.finished) return;
      if (kind === 'keyDown') {
        if ((code === 'Escape' || key === 'Escape') && Object.keys(rec.labels).length === 0) {
          rec.finished = true;
          finishKeyRecording(null);
          return;
        }
        const press = recordKeyPress({ code, key });
        if (!press) return;
        rec.labels[press.id] = press.label;
        rec.lastCombo = sortRecordedCombo(Object.values(rec.labels));
        setKeyRecordingPresses(rec.lastCombo);
        armTimer(rec, 3000);
      } else {
        armTimer(rec, 200);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handlePress('keyDown', e.key, e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handlePress('keyUp', e.key, e.code);
    };
    const onBlur = () => {
      const rec = keyRecordingRef.current;
      if (rec && !rec.finished) {
        rec.finished = true;
        // 窗口失焦兜底：已按过的键视为完成，直接填入
        finishKeyRecording(rec.lastCombo.length > 0 ? rec.lastCombo : null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    // 主进程兜底通道：渲染层 keydown 收不到时仍能捕获按键
    const unsubscribe = window.keyboardRecordAPI?.onKeyEvent((data) => handlePress(data.type, data.key, data.code));
    window.keyboardRecordAPI?.start().catch(() => {});
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      unsubscribe?.();
      window.keyboardRecordAPI?.stop().catch(() => {});
    };
  }, [keyRecording, finishKeyRecording]);

  const startKeyRecording = () => {
    keyRecordingRef.current = { labels: {}, lastCombo: [], timer: null, finished: false };
    setKeyRecording(true);
    setKeyRecordingPresses([]);
  };

  useEffect(() => {
    if (!window.templateAPI) {
      setTemplates([]);
      setFolders([]);
      return;
    }
    window.templateAPI
      .list()
      .then((data) => {
        setTemplates(data.templates);
        setFolders(data.folders);
      })
      .catch(() => {
        setTemplates([]);
        setFolders([]);
      });
  }, [templateVersion]);

  useEffect(() => {
    if (!window.streamAPI) {
      setStreamSources([]);
      return;
    }
    setStreamSourceLoading(true);
    window.streamAPI
      .list()
      .then(setStreamSources)
      .catch(() => setStreamSources([]))
      .finally(() => setStreamSourceLoading(false));
  }, [node?.type]);

  useEffect(() => {
    if (!window.cloudApiAPI) {
      setApiProfiles([]);
      return;
    }
    window.cloudApiAPI
      .list()
      .then(setApiProfiles)
      .catch(() => setApiProfiles([]));
  }, [cloudApiVersion, expandedStrategy]);

  useEffect(() => {
    if (!window.streamAPI) {
      setStreamSources([]);
      return;
    }
    window.streamAPI.list().then(setStreamSources).catch(() => setStreamSources([]));
  }, [expandedStrategy, node?.type]);

  const updateStrategy = useCallback(
    (strategyKey: StrategyKey, patch: Partial<LooseStrategy>) => {
      if (!node || node.type !== 'recognize') return;
      const strategies = node.data.strategies as unknown as Record<StrategyKey, LooseStrategy>;
      const next = {
        ...strategies,
        [strategyKey]: { ...strategies[strategyKey], ...patch },
      };
      onChangeNode(updateNodeData(node, { strategies: next as unknown as RecognizeNode['data']['strategies'] }));
    },
    [node, onChangeNode],
  );

  const DRAG_THRESHOLD = 6;

  const resolveDropIndex = useCallback((pointerY: number, draggingKey: StrategyKey): number | null => {
    const container = strategiesRef.current;
    if (!container || !node || node.type !== 'recognize') return null;
    const order = node.data.strategyOrder || STRATEGY_ORDER;
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.strategy-card'))
      .filter((card) => card.dataset.strategy !== draggingKey);
    if (cards.length === 0) return 0;
    for (let index = 0; index < cards.length; index += 1) {
      const rect = cards[index].getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        const targetKey = cards[index].dataset.strategy as StrategyKey;
        return order.filter((key) => key !== draggingKey).indexOf(targetKey);
      }
    }
    return cards.length;
  }, [node]);

  const handleHeaderPointerDown = useCallback((e: React.PointerEvent, strategyKey: StrategyKey) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('input, button, select, textarea')) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture may be unavailable in browser-based previews.
    }
    const list = strategiesRef.current;
    const card = e.currentTarget.closest('.strategy-card');
    if (!list || !card) return;
    const cardRect = card.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    dragRef.current = {
      strategy: strategyKey,
      startY: e.clientY,
      startTop: cardRect.top - listRect.top,
      startLeft: cardRect.left - listRect.left,
      width: cardRect.width,
      active: false,
    };
  }, []);

  const handleHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
    }
    const targetIndex = resolveDropIndex(e.clientY, drag.strategy);
    setDragUI({
      strategy: drag.strategy,
      top: drag.startTop + (e.clientY - drag.startY),
      left: drag.startLeft,
      width: drag.width,
      targetIndex,
    });
  }, [resolveDropIndex]);

  const handleHeaderPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.active) {
      const dropIndex = resolveDropIndex(e.clientY, drag.strategy);
      if (dropIndex !== null && node && node.type === 'recognize') {
        const order = [...(node.data.strategyOrder || STRATEGY_ORDER)];
        const filtered = order.filter((key) => key !== drag.strategy);
        const insertAt = Math.min(Math.max(dropIndex, 0), filtered.length);
        filtered.splice(insertAt, 0, drag.strategy);
        onChangeNode(updateNodeData(node, { strategyOrder: filtered }));
      }
      setDragUI(null);
      return;
    }
    setExpandedStrategy((current) => (current === drag.strategy ? null : drag.strategy));
    setDragUI(null);
  }, [node, onChangeNode, resolveDropIndex]);

  const handleHeaderPointerCancel = useCallback(() => {
    dragRef.current = null;
    setDragUI(null);
  }, []);

  const apiDragRef = useRef<{ id: string; from: number } | null>(null);
  const apiListRef = useRef<HTMLDivElement>(null);

  const getCloudApiIds = useCallback((): string[] => {
    if (!node || node.type !== 'recognize') return [];
    const strategy = (node.data.strategies as unknown as Record<StrategyKey, LooseStrategy>).cloudApi;
    return strategy.apiIds ?? (strategy.profileId ? [strategy.profileId] : []);
  }, [node]);

  const setCloudApiIds = useCallback(
    (ids: string[]) => {
      updateStrategy('cloudApi', { apiIds: ids, profileId: ids[0] ?? undefined });
    },
    [updateStrategy],
  );

  const addCloudApi = useCallback(
    (profileId: string) => {
      const ids = getCloudApiIds();
      if (ids.includes(profileId)) return;
      setCloudApiIds([...ids, profileId]);
    },
    [getCloudApiIds, setCloudApiIds],
  );

  const removeCloudApi = useCallback(
    (profileId: string) => {
      setCloudApiIds(getCloudApiIds().filter((id) => id !== profileId));
    },
    [getCloudApiIds, setCloudApiIds],
  );

  const handleApiGripPointerDown = useCallback((e: React.PointerEvent, id: string, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // pointer capture may be unavailable in previews
    }
    apiDragRef.current = { id, from: index };
  }, []);

  const handleApiGripPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = apiDragRef.current;
      const list = apiListRef.current;
      if (!drag || !list) return;
      const chips = Array.from(list.querySelectorAll<HTMLElement>('.api-chip'));
      const ids = [...getCloudApiIds()];
      for (let index = 0; index < chips.length; index += 1) {
        const rect = chips[index].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2 && index !== drag.from) {
          const next = [...ids];
          const [moved] = next.splice(drag.from, 1);
          next.splice(index, 0, moved);
          apiDragRef.current = { ...drag, from: index };
          setCloudApiIds(next);
          break;
        }
      }
    },
    [getCloudApiIds, setCloudApiIds],
  );

  const handleApiGripPointerUp = useCallback(() => {
    apiDragRef.current = null;
  }, []);

  if (!node) {
    return (
      <aside className="properties-panel">
        <div className="properties-panel__scroll">请选择一个节点</div>
      </aside>
    );
  }

  return (
    <aside className="properties-panel" style={style}>
      <div className="properties-panel__scroll">
        <div className="properties-panel__header">节点属性</div>

        <label>
          标题
          <input value={node.title} onChange={(e) => onChangeNode({ ...node, title: e.target.value })} />
        </label>

        <label className="checkbox-row">
          <span>启用该节点</span>
          <input
            type="checkbox"
            checked={node.enabled !== false}
            onChange={(e) => onChangeNode({ ...node, enabled: e.target.checked })}
          />
        </label>

        {node.type === 'click' && (
          <section className="properties-panel__group">
            <h3>点击配置</h3>
            <p className="properties-panel__hint">点击节点依赖识别节点的输出坐标</p>
          </section>
        )}


        {node.type === 'wait' && (
          <section className="properties-panel__group">
            <h3>等待配置</h3>
            <label>
              模式
              <CustomSelect
                value={node.data.mode}
                options={[
                  { value: 'delay', label: '延时' },
                  { value: 'condition', label: '条件' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { mode: v as 'delay' | 'condition' }))}
              />
            </label>
            {node.data.mode === 'delay' ? (
              <label>
                延时毫秒
                <input
                  type="number"
                  value={node.data.delayMs ?? 1000}
                  onChange={(e) => onChangeNode(updateNodeData(node, { delayMs: Number(e.target.value) }))}
                />
              </label>
            ) : (
              <label>
                条件文本
                <input
                  value={node.data.conditionText ?? ''}
                  onChange={(e) => onChangeNode(updateNodeData(node, { conditionText: e.target.value }))}
                />
              </label>
            )}
          </section>
        )}

        {node.type === 'screenshot' && (
          <section className="properties-panel__group">
            <h3>截图配置</h3>
            <label>
              区域
              <CustomSelect
                value={node.data.regionMode}
                options={[
                  { value: 'full', label: '全屏' },
                  { value: 'selected', label: '选区' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { regionMode: v as 'full' | 'selected' }))}
              />
            </label>
            {node.data.regionMode === 'selected' && (
              <>
                <p className="properties-panel__hint">执行时将只截取以下区域（相对所选屏幕/串流画面左上角）</p>
                <div className="grid-two">
                  <label>
                    X
                    <input
                      type="number"
                      value={node.data.region?.x ?? 0}
                      onChange={(e) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { y: 0, width: 100, height: 100 }), x: Number(e.target.value) } }))}
                    />
                  </label>
                  <label>
                    Y
                    <input
                      type="number"
                      value={node.data.region?.y ?? 0}
                      onChange={(e) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, width: 100, height: 100 }), y: Number(e.target.value) } }))}
                    />
                  </label>
                  <label>
                    宽
                    <input
                      type="number"
                      min={1}
                      value={node.data.region?.width ?? 100}
                      onChange={(e) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, y: 0, height: 100 }), width: Number(e.target.value) } }))}
                    />
                  </label>
                  <label>
                    高
                    <input
                      type="number"
                      min={1}
                      value={node.data.region?.height ?? 100}
                      onChange={(e) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, y: 0, width: 100 }), height: Number(e.target.value) } }))}
                    />
                  </label>
                </div>
              </>
            )}
            <label>
              来源
              <CustomSelect
                value={node.data.source ?? 'screen'}
                options={[
                  { value: 'screen', label: '系统屏幕' },
                  { value: 'window', label: '本机指定窗口' },
                  { value: 'stream', label: '串流窗口' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { source: v as 'screen' | 'window' | 'stream' }))}
              />
            </label>
            {node.data.source === 'window' && (
              <>
                <label>
                  窗口标题关键字（可选，用于标题匹配）
                  <input
                    value={node.data.windowHint ?? ''}
                    onChange={(e) => onChangeNode(updateNodeData(node, { windowHint: e.target.value }))}
                    placeholder="例如：Remote Play / Excel / 游戏名"
                  />
                </label>
                {node.data.windowId !== undefined && (
                  <div className="properties-panel__lock-chip">
                    <span className="properties-panel__lock-dot" />
                    已锁定窗口 · ID {node.data.windowId}
                    {node.data.windowApp ? ` · ${node.data.windowApp}` : ''}
                    <button
                      className="properties-panel__ghost-button properties-panel__lock-clear"
                      onClick={() => onChangeNode(updateNodeData(node, { windowId: undefined, windowApp: undefined }))}
                    >
                      解除锁定
                    </button>
                  </div>
                )}
                <div className="properties-panel__window-picker">
                  <button
                    className="properties-panel__ghost-button"
                    onClick={async () => {
                      if (!window.streamAPI || probingWindows) return;
                      setProbingWindows(true);
                      try {
                        const result = await window.streamAPI.probeWindows();
                        setWindows(result.windows);
                      } catch {
                        setWindows([]);
                      } finally {
                        setProbingWindows(false);
                      }
                    }}
                    disabled={probingWindows}
                  >
                    {probingWindows ? '扫描中…' : '扫描窗口并选择'}
                  </button>
                  {windows.length > 0 && (
                    <div className="properties-panel__window-list">
                      {windows.map((win) => {
                        const isLocked = win.windowId !== undefined && win.windowId === node.data.windowId;
                        return (
                          <button
                            key={win.id}
                            className={isLocked ? 'active' : ''}
                            onClick={() =>
                              onChangeNode(updateNodeData(node, {
                                windowHint: win.name,
                                windowId: win.windowId,
                                windowApp: win.windowApp,
                              }))
                            }
                            title={`${win.name}${win.windowId !== undefined ? ` · ID ${win.windowId}` : ''}${win.windowApp ? ` · ${win.windowApp}` : ''}`}
                          >
                            {win.name}
                            {win.windowId !== undefined && (
                              <span className={isLocked ? 'properties-panel__window-app active' : 'properties-panel__window-app'}>
                                ID{win.windowId} · {win.windowApp ?? ''}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {node.data.windowHint && (
                    <p className="properties-panel__window-hint">
                      选择窗口会自动记下稳定的窗口 ID，标题改变也能继续定位；仅标题匹配则填写上方关键字。
                    </p>
                  )}
                </div>
              </>
            )}
            {node.data.source === 'stream' && (
              <label>
                串流设备
                <CustomSelect
                  value={node.data.streamSourceId ?? ''}
                  options={[
                    { value: '', label: streamSourceLoading ? '正在加载串流设备…' : '选择一个串流设备' },
                    ...streamSources.map((source) => {
                      const typeLabel =
                        source.type === 'local' ? '本机' : source.type === 'ps5' ? 'PS5' : source.type === 'xbox' ? 'Xbox' : source.type === 'secondPc' ? '第二台电脑' : '其他设备';
                      return { value: source.id, label: `${source.name} · ${typeLabel}` };
                    }),
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                />
              </label>
            )}
          </section>
        )}

        {node.type === 'if' && (
          <section className="properties-panel__group">
            <h3>判断配置</h3>
            <label>
              表达式
              <input
                value={node.data.expression}
                onChange={(e) => onChangeNode(updateNodeData(node, { expression: e.target.value }))}
              />
            </label>
          </section>
        )}

        {node.type === 'loop' && (
          <section className="properties-panel__group">
            <h3>循环配置</h3>
            <p className="properties-panel__hint">Loop 通过角色区分：Begin 负责开始循环，Down 负责循环结束后继续。每个节点只有左侧输入点和右侧输出点。</p>
            {node.data.role === 'down' ? (
              <p className="properties-panel__hint">循环次数/条件请在配对的 Loop Begin 上设置，Down 只负责结束循环并继续后续步骤。</p>
            ) : (
              <>
                <label>
                  模式
                  <CustomSelect
                    value={node.data.mode}
                    options={[
                      { value: 'count', label: '次数' },
                      { value: 'condition', label: '条件' },
                    ]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { mode: v as 'count' | 'condition' }))}
                  />
                </label>
                {node.data.mode === 'count' ? (
                  <label>
                    次数
                    <input
                      type="number"
                      value={node.data.count ?? 3}
                      onChange={(e) => onChangeNode(updateNodeData(node, { count: Number(e.target.value) }))}
                    />
                  </label>
                ) : (
                  <label>
                    条件文本
                    <input
                      value={node.data.conditionText ?? ''}
                      onChange={(e) => onChangeNode(updateNodeData(node, { conditionText: e.target.value }))}
                    />
                  </label>
                )}
              </>
            )}
          </section>
        )}

        {node.type === 'scroll' && (
          <section className="properties-panel__group">
            <h3>滚动配置</h3>
            <p className="properties-panel__hint">滚动量不是像素值，而是滚轮滚动步数；不同系统和应用的实际效果可能不同。</p>
            <label>
              方向
              <CustomSelect
                value={node.data.direction}
                options={[
                  { value: 'up', label: '向上' },
                  { value: 'down', label: '向下' },
                  { value: 'left', label: '向左' },
                  { value: 'right', label: '向右' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { direction: v as 'up' | 'down' | 'left' | 'right' }))}
              />
            </label>
            <label>
              滚动档位
              <CustomSelect
                value={node.data.preset ?? 'medium'}
                options={[
                  { value: 'small', label: '小幅' },
                  { value: 'medium', label: '中幅' },
                  { value: 'large', label: '大幅' },
                  { value: 'custom', label: '自定义' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { preset: v as 'small' | 'medium' | 'large' | 'custom' }))}
              />
            </label>
            {(node.data.preset ?? 'medium') === 'custom' && (
              <label>
                自定义滚动量
                <input
                  type="number"
                  min={0}
                  value={node.data.customAmount ?? 300}
                  onChange={(e) => onChangeNode(updateNodeData(node, { customAmount: Math.max(0, Number(e.target.value)) }))}
                />
              </label>
            )}
            <p className="properties-panel__hint">建议先用小/中/大幅，只有要精确控制时再切到自定义。</p>
          </section>
        )}

        {node.type === 'keyboard' && (
          <section className="properties-panel__group">
            <h3>键盘配置</h3>
            {node.data.mode !== 'type' ? (
              <>
                <button
                  className={`properties-panel__key-record-btn${keyRecording ? ' properties-panel__key-record-btn--recording' : ''}`}
                  onClick={(e) => {
                    (e.currentTarget as HTMLButtonElement).blur();
                    if (keyRecording) {
                      finishKeyRecording(null);
                    } else {
                      startKeyRecording();
                    }
                  }}
                >
                  {keyRecording ? '● 录制中… 松开即填入（Esc 取消）' : '录制按键'}
                </button>
                {keyRecording && (
                  <span className="properties-panel__key-record-hint">
                    {keyRecordingPresses.length > 0
                      ? `已捕获：${keyRecordingPresses.join(' + ')}`
                      : '按下按键，例如 A、⌘←'}
                  </span>
                )}
                <label>
                  按键
                  <input
                    className="properties-panel__key-input--muted"
                    value={node.data.keys}
                    placeholder={keyRecording ? '正在录制…' : '或手动输入，例如 A / enter'}
                    onChange={(e) => onChangeNode(updateNodeData(node, { keys: e.target.value }))}
                  />
                </label>
              </>
            ) : (
              <label>
                按键
                <input
                  value={node.data.keys}
                  placeholder="例如：ABCD 或 你好"
                  onChange={(e) => onChangeNode(updateNodeData(node, { keys: e.target.value }))}
                />
              </label>
            )}
            <label>
              模式
              <CustomSelect
                value={node.data.mode}
                options={[
                  { value: 'tap', label: '点击（按下并松开）' },
                  { value: 'hold', label: '按住（长按）' },
                  { value: 'type', label: '连续输入（逐字符输入）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { mode: v as 'tap' | 'hold' | 'type' }))}
              />
            </label>
            {node.data.mode === 'type' && (
              <label>
                输入间隔（毫秒）
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={node.data.interval ?? 200}
                  onChange={(e) => onChangeNode(updateNodeData(node, { interval: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>
            )}
            <p className="properties-panel__hint">
              {node.data.mode === 'type'
                ? '逐字符输入：ABCD 打大写，{enter}、{tab}、{esc} 表示特殊键'
                : '推荐用上方「录制按键」录入；也可手动写：A、command+left、enter'}
            </p>
          </section>
        )}

        {node.type === 'recognize' && (
          <section className="properties-panel__group properties-panel__group--recognize" onWheel={(e) => e.stopPropagation()}>
            <h3>识别配置</h3>
            <label>
              执行模式
              <CustomSelect
                value={node.data.executionMode}
                options={[
                  { value: 'cascade', label: '级联' },
                  { value: 'parallel', label: '并行' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { executionMode: v as 'cascade' | 'parallel' }))}
              />
            </label>

            <div className="strategy-list" ref={strategiesRef}>
              {(node.data.strategyOrder || STRATEGY_ORDER).map((strategyKey: StrategyKey) => {
              const strategy = (node.data.strategies as unknown as Record<StrategyKey, LooseStrategy>)[strategyKey];
              const order = node.data.strategyOrder || STRATEGY_ORDER;
              const strategyIndex = STRATEGY_NUMBERS[strategyKey];
              const expanded = expandedStrategy === strategyKey;
              const isDraggingThis = dragUI?.strategy === strategyKey;
              const visibleOrder = order.filter((key) => key !== dragUI?.strategy);
              const visibleIndex = visibleOrder.indexOf(strategyKey);
              const showGapBefore = dragUI !== null && dragUI.targetIndex === visibleIndex;
              const showGapAfter =
                dragUI !== null &&
                visibleIndex === visibleOrder.length - 1 &&
                dragUI.targetIndex === visibleOrder.length;

              return (
                <Fragment key={`${strategyKey}-item`}>
                  {showGapBefore && <div className="strategy-card__gap" aria-hidden="true" />}
                <div
                  data-strategy={strategyKey}
                  className={`strategy-card ${isDraggingThis ? 'strategy-card--ghost' : ''} ${expanded ? 'strategy-card--expanded' : ''}`}
                  style={
                    isDraggingThis && dragUI
                      ? {
                          position: 'absolute',
                          top: `${dragUI.top}px`,
                          left: `${dragUI.left}px`,
                          width: `${dragUI.width}px`,
                          zIndex: 50,
                          margin: 0,
                        }
                      : undefined
                  }
                >
                  <div
                    className="strategy-card__header"
                    onPointerDown={(e) => handleHeaderPointerDown(e, strategyKey)}
                    onPointerMove={handleHeaderPointerMove}
                    onPointerUp={handleHeaderPointerUp}
                    onPointerCancel={handleHeaderPointerCancel}
                    style={{ touchAction: 'none' }}
                  >
                    <span className="strategy-card__grip" aria-hidden="true">
                      ⋮⋮
                    </span>
                    <span className="strategy-card__index">{strategyIndex}</span>
                    <span className="strategy-card__name">{STRATEGY_NAMES[strategyKey]}</span>
                    <input
                      type="checkbox"
                      checked={strategy.enabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updateStrategy(strategyKey, { enabled: e.target.checked })}
                      title={strategy.enabled ? '停用该策略' : '启用该策略'}
                    />
                    <span className={`strategy-card__chevron ${expanded ? 'open' : ''}`}>▾</span>
                  </div>

                  {expanded && (
                    <div className="strategy-card__body">
                      {strategyKey === 'coords' && (
                        <>
                          <div className="grid-two">
                            <label>
                              X
                              <input
                                type="number"
                                value={strategy.x ?? 0}
                                onChange={(e) => updateStrategy('coords', { x: Number(e.target.value) })}
                              />
                            </label>
                            <label>
                              Y
                              <input
                                type="number"
                                value={strategy.y ?? 0}
                                onChange={(e) => updateStrategy('coords', { y: Number(e.target.value) })}
                              />
                            </label>
                          </div>
                        </>
                      )}

                      {strategyKey === 'template' && (
                        <>
                          <label>
                            匹配模板
                            <TemplatePicker
                              templates={templates}
                              folders={folders}
                              value={strategy.templateId}
                              onChange={(templateId) => updateStrategy('template', { templateId })}
                            />
                          </label>
                          <button className="properties-panel__ghost-button" onClick={onOpenTemplateManager}>
                            管理模板…
                          </button>
                          <label>
                            阈值
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={strategy.threshold ?? 60}
                              onChange={(e) => updateStrategy('template', { threshold: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}

                      {strategyKey === 'yolo' && (
                        <>
                          <label>
                            模型
                            <ModelPicker
                              value={strategy.modelId}
                              onChange={(model) => updateStrategy('yolo', { modelId: model.id, modelPath: model.path })}
                              refreshKey={yoloVersion ?? 0}
                            />
                          </label>
                          {onOpenYoloManager && (
                            <button className="properties-panel__ghost-button" onClick={onOpenYoloManager}>
                              管理模型…
                            </button>
                          )}
                          <label>
                            阈值
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={strategy.threshold ?? 60}
                              onChange={(e) => updateStrategy('yolo', { threshold: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}

                      {strategyKey === 'ocr' && (
                        <>
                          <label>
                            查找文字
                            <input
                              value={strategy.text ?? ''}
                              onChange={(e) => updateStrategy('ocr', { text: e.target.value })}
                            />
                          </label>
                          <label>
                            OCR 引擎
                            <CustomSelect
                              value={strategy.engine ?? 'auto'}
                              options={OCR_ENGINE_OPTIONS}
                              onChange={(v) => updateStrategy('ocr', { engine: v as OcrEngine })}
                            />
                          </label>
                          <label>
                            阈值
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={strategy.threshold ?? 60}
                              onChange={(e) => updateStrategy('ocr', { threshold: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}

                      {strategyKey === 'cloudApi' && (
                        <>
                          <label>
                            执行模式
                            <CustomSelect
                              value={strategy.apiMode ?? 'cascade'}
                              options={[
                                { value: 'cascade', label: '级联（按顺序逐个尝试，命中即停）' },
                                { value: 'parallel', label: '并行（同时请求，取最高优先级结果）' },
                              ]}
                              onChange={(v) => updateStrategy('cloudApi', { apiMode: v as 'cascade' | 'parallel' })}
                            />
                          </label>
                          <div className="api-chip-list" ref={apiListRef}>
                            {getCloudApiIds().map((id, index) => {
                              const profile = apiProfiles.find((p) => p.id === id);
                              return (
                                <div
                                  key={id}
                                  className={`api-chip ${apiDragRef.current?.id === id ? 'api-chip--dragging' : ''}`}
                                >
                                  <span
                                    className="api-chip__grip"
                                    title="拖动排序"
                                    style={{ touchAction: 'none' }}
                                    onPointerDown={(e) => handleApiGripPointerDown(e, id, index)}
                                    onPointerMove={handleApiGripPointerMove}
                                    onPointerUp={handleApiGripPointerUp}
                                    onPointerCancel={handleApiGripPointerUp}
                                  >
                                    ⋮⋮
                                  </span>
                                  <span className="api-chip__index">{index + 1}</span>
                                  <span className="api-chip__name">{profile?.name ?? id}</span>
                                  {profile && (
                                    <span className={`api-chip__status ${profile.lastTestStatus === 'ok' ? 'ok' : profile.lastTestStatus === 'error' ? 'bad' : 'idle'}`}>
                                      {profile.lastTestStatus === 'ok' ? '✓' : profile.lastTestStatus === 'error' ? '✗' : '·'}
                                    </span>
                                  )}
                                  <button
                                    className="api-chip__remove"
                                    title="移除"
                                    onClick={() => removeCloudApi(id)}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                            {getCloudApiIds().length === 0 && (
                              <p className="properties-panel__hint">还没有选择 API，从下方添加一个或多个配置</p>
                            )}
                          </div>
                          {apiProfiles.filter((p) => !getCloudApiIds().includes(p.id)).length > 0 && (
                            <label>
                              添加 API
                              <CustomSelect
                                value=""
                                options={[
                                  { value: '', label: '选择要添加的 API…' },
                                  ...apiProfiles
                                    .filter((p) => !getCloudApiIds().includes(p.id))
                                    .map((p) => ({ value: p.id, label: p.name })),
                                ]}
                                onChange={(v) => {
                                  if (v) addCloudApi(v);
                                }}
                              />
                            </label>
                          )}
                          <button className="properties-panel__ghost-button" onClick={onOpenCloudApiManager}>
                            管理 API…
                          </button>
                          <label>
                            提示词
                            <textarea
                              value={strategy.prompt ?? ''}
                              onChange={(e) => updateStrategy('cloudApi', { prompt: e.target.value })}
                            />
                          </label>
                          <label>
                            阈值
                            <input
                              type="number"
                              min={0}
                              max={100}
                              value={strategy.threshold ?? 60}
                              onChange={(e) => updateStrategy('cloudApi', { threshold: Number(e.target.value) })}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  )}
                </div>
                  {showGapAfter && <div className="strategy-card__gap" aria-hidden="true" />}
                </Fragment>
              );
            })}
              <button className="properties-panel__ghost-button properties-panel__recognize-test" onClick={onOpenRecognizeTest}>
                测试台验证
              </button>
              <div className="properties-panel__recognize-spacer" aria-hidden="true" />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}