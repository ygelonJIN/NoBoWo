import type { CloudApiProfile, ConditionType, GamepadAction, MoveDirection, OcrEngine, RecognizeNode, StreamSourceProfile, StreamWindowInfo, TemplateDefinition, TemplateFolder, WorkflowNode } from '@nobowo/core';
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { CustomSelect } from './CustomSelect';
import { FrameRateSelect } from './FrameRateSelect';
import { ModelPicker } from './ModelPicker';
import { TemplatePicker } from './TemplatePicker';

type Props = {
  node: WorkflowNode | null;
  onChangeNode: (node: WorkflowNode) => void;
  allNodes?: WorkflowNode[];
  style?: CSSProperties;
  templateVersion: number;
  streamVersion?: number;
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

type NumberInputProps = {
  value: number | undefined;
  fallback: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
};

/** Keep an editable draft while typing so clearing the field does not immediately reset it. */
function NumberInput({ value, fallback, min, max, step, onChange }: NumberInputProps) {
  const [draft, setDraft] = useState(() => String(value ?? fallback));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(value ?? fallback));
  }, [editing, fallback, value]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() === '') {
      setDraft(String(value ?? fallback));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value ?? fallback));
      return;
    }
    const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed));
    onChange(clamped);
    setDraft(String(clamped));
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        setEditing(true);
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(String(value ?? fallback));
          event.currentTarget.blur();
        }
      }}
    />
  );
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
  allNodes = [],
  style,
  templateVersion,
  streamVersion = 0,
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
  const isDirectStream = (id?: string) => Boolean(id && streamSources.find((source) => source.id === id)?.transport === 'ps5Direct');
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
  }, [node?.type, streamVersion]);

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
  }, [expandedStrategy, node?.type, streamVersion]);

  useEffect(() => {
    if (node?.type !== 'gamepad' || node.data.target !== 'stream' || node.data.streamSourceId || streamSources.length === 0) return;
    onChangeNode(updateNodeData(node, { streamSourceId: streamSources[0].id, streamWindowHint: undefined }));
  }, [node, onChangeNode, streamSources]);

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
                <NumberInput
                  value={node.data.delayMs}
                  fallback={1000}
                  min={0}
                  onChange={(value) => onChangeNode(updateNodeData(node, { delayMs: value }))}
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
                    <NumberInput
                      value={node.data.region?.x}
                      fallback={0}
                      onChange={(value) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { y: 0, width: 100, height: 100 }), x: value } }))}
                    />
                  </label>
                  <label>
                    Y
                    <NumberInput
                      value={node.data.region?.y}
                      fallback={0}
                      onChange={(value) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, width: 100, height: 100 }), y: value } }))}
                    />
                  </label>
                  <label>
                    宽
                    <NumberInput
                      value={node.data.region?.width}
                      fallback={100}
                      min={1}
                      onChange={(value) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, y: 0, height: 100 }), width: value } }))}
                    />
                  </label>
                  <label>
                    高
                    <NumberInput
                      value={node.data.region?.height}
                      fallback={100}
                      min={1}
                      onChange={(value) => onChangeNode(updateNodeData(node, { region: { ...(node.data.region ?? { x: 0, y: 0, width: 100 }), height: value } }))}
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
                        source.type === 'local' ? '本机' : source.type === 'ps5' ? 'PS5' : source.type === 'xbox' ? '其他设备' : source.type === 'secondPc' ? '第二台电脑' : '其他设备';
                      return { value: source.id, label: `${source.name} · ${typeLabel}` };
                    }),
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                />
              </label>
            )}
          </section>
        )}

        {node.type === 'if' && (() => {
          const conditionType = node.data.conditionType ?? 'lastOk';
          const conditionOptions: { value: ConditionType; label: string; description: string }[] = [
            { value: 'lastOk', label: '上一次节点', description: '检查前面连线的节点是否执行成功' },
            { value: 'nodeCheck', label: '指定节点', description: '监视某个节点的状态（不需要连线）' },
            { value: 'spatialArrived', label: '空间检测已到达', description: '最近一次 Spatial Detector 已连续满足到达阈值' },
            { value: 'spatialNotArrived', label: '空间检测未到达', description: '最近一次 Spatial Detector 尚未满足到达阈值' },
            { value: 'gameplayOffense', label: '游戏正在进攻', description: '最近一次 Gameplay State 稳定状态为 offense' },
            { value: 'gameplayDefense', label: '游戏正在防守', description: '最近一次 Gameplay State 稳定状态为 defense' },
            { value: 'gameplayStateChanged', label: '攻防状态已切换', description: '最近一次 Gameplay State 发生确认后的状态变化' },
            { value: 'custom', label: '自定义表达式', description: '手写JavaScript表达式（高级模式）' },
          ];
          const currentOption = conditionOptions.find((opt) => opt.value === conditionType) ?? conditionOptions[0];

          // Auto-generate expression based on conditionType
          const getExpression = (type: ConditionType): string => {
            switch (type) {
              case 'lastOk': return 'ctx.lastOk';
              case 'nodeCheck': {
                // Find node by title
                const targetTitle = node.data.targetNodeTitle ?? '';
                const targetNode = allNodes.find((n) => n.title === targetTitle);
                return targetNode ? `ctx.results['${targetNode.id}']?.status === 'ok'` : 'ctx.lastOk';
              }
              case 'spatialArrived': return 'ctx.spatial?.arrived === true';
              case 'spatialNotArrived': return 'ctx.spatial?.arrived !== true';
              case 'gameplayOffense': return 'ctx.gameplayState === "offense"';
              case 'gameplayDefense': return 'ctx.gameplayState === "defense"';
              case 'gameplayStateChanged': return 'ctx.gameplayStateChanged === true';
              case 'custom': return node.data.expression ?? 'true';
              default: return 'ctx.lastOk';
            }
          };

          const handleConditionTypeChange = (type: ConditionType) => {
            const expr = getExpression(type);
            onChangeNode(updateNodeData(node, { conditionType: type, expression: expr }));
          };

          return (
            <section className="properties-panel__group">
              <h3>判断配置</h3>
              <label>
                条件类型
                <CustomSelect
                  value={conditionType}
                  options={conditionOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
                  onChange={(v) => handleConditionTypeChange(v as ConditionType)}
                />
              </label>
              <p className="properties-panel__hint">{currentOption.description}</p>

              {conditionType === 'custom' ? (
                <>
                  <label>
                    表达式
                    <input
                      value={node.data.expression ?? ''}
                      onChange={(e) => onChangeNode(updateNodeData(node, { expression: e.target.value }))}
                      placeholder="例如：ctx.lastOk && ctx.last.x > 300"
                    />
                  </label>
                  <div className="properties-panel__hint">
                    <p>可用变量：</p>
                    <ul>
                      <li><code>ctx.lastOk</code> — 上一次检测是否成功</li>
                      <li><code>ctx.last</code> — 上一次检测结果（含 x, y, nodeId）</li>
                      <li><code>ctx.frame</code> — 是否有截图</li>
                      <li><code>ctx.spatial</code> — 最近一次空间检测的距离、方向、世界坐标和到达状态</li>
                      <li><code>ctx.results</code> — 所有节点的执行结果</li>
                    </ul>
                  </div>
                </>
              ) : null}
              {conditionType === 'nodeCheck' ? (
                <label>
                  选择节点
                  <CustomSelect
                    value={node.data.targetNodeTitle ?? ''}
                    options={[
                      { value: '', label: '请选择节点' },
                      ...allNodes
                        .filter((n) => n.id !== node.id)
                        .map((n) => ({ value: n.title, label: n.title }))
                    ]}
                    onChange={(v) => {
                      const expr = getExpression(conditionType);
                      onChangeNode(updateNodeData(node, { targetNodeTitle: v, expression: expr }));
                    }}
                  />
                </label>
              ) : null}
              <p className="properties-panel__hint" style={{ fontSize: '11px', opacity: 0.6 }}>
                映射表达式：{node.data.expression ?? getExpression(conditionType)}
              </p>
            </section>
          );
        })()}

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
                    <NumberInput
                      value={node.data.count}
                      fallback={3}
                      min={0}
                      onChange={(value) => onChangeNode(updateNodeData(node, { count: value }))}
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
                <NumberInput
                  value={node.data.customAmount}
                  fallback={300}
                  min={0}
                  onChange={(value) => onChangeNode(updateNodeData(node, { customAmount: value }))}
                />
              </label>
            )}
            <p className="properties-panel__hint">建议先用小/中/大幅，只有要精确控制时再切到自定义。</p>
          </section>
        )}

        {node.type === 'keyboard' && (
          <section className="properties-panel__group">
            <h3>键盘配置</h3>
            <label>
              发送目标
              <CustomSelect
                value={node.data.target ?? 'global'}
                options={[
                  { value: 'global', label: '系统全局' },
                  { value: 'stream', label: '指定串流设备' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { target: v as 'global' | 'stream' }))}
              />
            </label>
            {(node.data.target ?? 'global') === 'stream' && (
              <>
                <label>
                  串流设备
                  <CustomSelect
                    value={node.data.streamSourceId ?? ''}
                    options={[{ value: '', label: '未选择' }, ...streamSources.map((s) => ({ value: s.id, label: s.name || s.windowHint || s.id }))]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                  />
                </label>
                {!isDirectStream(node.data.streamSourceId) && (
                  <label>
                    窗口标题关键字（可选）
                    <input
                      value={node.data.streamWindowHint ?? ''}
                      onChange={(e) => onChangeNode(updateNodeData(node, { streamWindowHint: e.target.value }))}
                      placeholder="例如：Remote Play / Chiaki / Moonlight"
                    />
                  </label>
                )}
                <p className="properties-panel__hint">
                  {isDirectStream(node.data.streamSourceId)
                    ? 'PS5 直连设备：键盘事件直接映射为 Remote Play 协议控制器事件，不依赖窗口焦点。'
                    : '外部窗口设备：按键发送到对应串流窗口；若未找到窗口，将回退到系统全局按键。'}
                </p>
              </>
            )}
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
                <NumberInput
                  value={node.data.interval}
                  fallback={200}
                  min={0}
                  max={10000}
                  onChange={(value) => onChangeNode(updateNodeData(node, { interval: value }))}
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

        {node.type === 'spatialDetector' && (
          <section className="properties-panel__group">
            <h3>空间检测配置</h3>
            <p className="properties-panel__hint">
              通用 Player → Target 检测。节点输出两者的图像坐标、可选世界坐标、最近距离、移动方向和到达状态。
            </p>
            <label>
              画面获取
              <CustomSelect
                value={node.data.captureMode ?? 'live'}
                options={[
                  { value: 'live', label: '实时取景（自动截图）' },
                  { value: 'frame', label: '单帧（使用前面的 Screenshot）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { captureMode: v as 'live' | 'frame' }))}
              />
            </label>
            {(node.data.captureMode ?? 'live') === 'live' && (
              <>
                <label>
                  画面来源
                  <CustomSelect
                    value={node.data.source ?? 'stream'}
                    options={[
                      { value: 'stream', label: '串流设备' },
                      { value: 'window', label: '本机窗口' },
                      { value: 'screen', label: '系统屏幕' },
                    ]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { source: v as 'screen' | 'window' | 'stream' }))}
                  />
                </label>
                {(node.data.source ?? 'stream') === 'stream' && (
                  <label>
                    串流设备
                    <CustomSelect
                      value={node.data.streamSourceId ?? ''}
                      options={[
                        { value: '', label: streamSources.length > 0 ? '未选择' : '尚未配置串流设备' },
                        ...streamSources.map((source) => ({ value: source.id, label: source.name || source.id })),
                      ]}
                      onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                    />
                  </label>
                )}
                {(node.data.source ?? 'stream') === 'window' && (
                  <label>
                    窗口标题关键字
                    <input
                      value={node.data.windowHint ?? ''}
                      onChange={(e) => onChangeNode(updateNodeData(node, { windowHint: e.target.value }))}
                      placeholder="例如：Remote Play / Chrome / 游戏名"
                    />
                  </label>
                )}
                <div className="grid-two">
                  <label>
                    处理帧率
                    <FrameRateSelect
                      value={node.data.fps}
                      sourceLabel="跟随串流/来源"
                      onChange={(value) => onChangeNode(updateNodeData(node, { fps: value }))}
                    />
                  </label>
                  <label>
                    启动超时（ms）
                    <NumberInput
                      value={node.data.timeoutMs}
                      fallback={5000}
                      min={250}
                      step={100}
                      onChange={(value) => onChangeNode(updateNodeData(node, { timeoutMs: value }))}
                    />
                  </label>
                </div>
                <p className="properties-panel__hint">
                  Player 和 Target 可以在不同帧出现并跨帧缓存。任一目标出现后持续等待另一个，不判失败；启动超时只针对两者都未出现。FPS 是采集/调度目标，实际推理 FPS 受模型和硬件限制。
                </p>
              </>
            )}
            <label>
              YOLO 模型
              <ModelPicker
                value={node.data.modelPath}
                onChange={(model) => onChangeNode(updateNodeData(node, {
                  modelId: model.id,
                  modelPath: model.path,
                  numClasses: model.numClasses ?? node.data.numClasses,
                }))}
                refreshKey={yoloVersion ?? 0}
              />
            </label>
            {onOpenYoloManager && (
              <button className="properties-panel__ghost-button" onClick={onOpenYoloManager}>
                管理模型…
              </button>
            )}
            <div className="grid-two">
              <label>
                Player 标签
                <input
                  value={node.data.playerLabel}
                  onChange={(e) => onChangeNode(updateNodeData(node, { playerLabel: e.target.value }))}
                  placeholder="例如：player"
                />
              </label>
              <label>
                Target 标签
                <input
                  value={node.data.targetLabel}
                  onChange={(e) => onChangeNode(updateNodeData(node, { targetLabel: e.target.value }))}
                  placeholder="例如：target"
                />
              </label>
            </div>
            <div className="grid-two">
              <label>
                类别数（模型可自动识别）
                <NumberInput
                  value={node.data.numClasses}
                  fallback={2}
                  min={1}
                  onChange={(value) => onChangeNode(updateNodeData(node, { numClasses: value }))}
                />
              </label>
              <label>
                置信阈值
                <NumberInput
                  value={node.data.threshold}
                  fallback={60}
                  min={0}
                  max={100}
                  onChange={(value) => onChangeNode(updateNodeData(node, { threshold: value }))}
                />
              </label>
            </div>
            <div className="grid-two">
              {node.data.targetAnchor !== 'boxDistance' && (
                <label>
                  Player 锚点
                  <CustomSelect
                    value={node.data.playerAnchor}
                    options={[
                      { value: 'boxCenter', label: '检测框中心' },
                      { value: 'keypoint', label: 'YOLO 关键点' },
                    ]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { playerAnchor: v as 'boxCenter' | 'keypoint' }))}
                  />
                </label>
              )}
              <label>
                Target 锚点
                <CustomSelect
                  value={node.data.targetAnchor}
                  options={[
                    { value: 'boxDistance', label: '两框边界最近距离' },
                    { value: 'nearestBoxPoint', label: '检测框最近点' },
                    { value: 'boxCenter', label: '检测框中心' },
                    { value: 'keypoint', label: 'YOLO 关键点' },
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { targetAnchor: v as 'boxDistance' | 'boxCenter' | 'nearestBoxPoint' | 'keypoint' }))}
                />
              </label>
            </div>
            {node.data.targetAnchor !== 'boxDistance' && node.data.playerAnchor === 'keypoint' && (
              <label>
                Player 关键点名称/ID
                <input
                  value={node.data.playerKeypoint ?? ''}
                  onChange={(e) => onChangeNode(updateNodeData(node, { playerKeypoint: e.target.value || undefined }))}
                  placeholder="留空使用第一个关键点"
                />
              </label>
            )}
            {node.data.targetAnchor === 'keypoint' && (
              <label>
                Target 关键点名称/ID
                <input
                  value={node.data.targetKeypoint ?? ''}
                  onChange={(e) => onChangeNode(updateNodeData(node, { targetKeypoint: e.target.value || undefined }))}
                  placeholder="留空使用第一个关键点"
                />
              </label>
            )}
            <div className="grid-two">
              <label>
                到达阈值
                <NumberInput
                  value={node.data.arrivalTolerance}
                  fallback={5}
                  min={0}
                  step={0.1}
                  onChange={(value) => onChangeNode(updateNodeData(node, { arrivalTolerance: value }))}
                />
              </label>
              <label>
                稳定帧数
                <NumberInput
                  value={node.data.stabilityFrames}
                  fallback={3}
                  min={1}
                  max={120}
                  onChange={(value) => onChangeNode(updateNodeData(node, { stabilityFrames: value }))}
                />
              </label>
            </div>
            <p className="properties-panel__hint">未配置标定时，阈值单位是图像像素；配置后，距离和阈值使用世界坐标单位。</p>
            <p className="properties-panel__hint">如果选择“两框边界最近距离”，系统会直接计算 Player 框和 Target 框边界之间的像素距离，不需要设置 Player/Target 锚点；两框重叠时距离为 0。</p>
            <label>
              目标类型
              <CustomSelect
                value={node.data.targetMode ?? 'detection'}
                options={[
                  { value: 'detection', label: 'YOLO Target 检测' },
                  { value: 'polyline', label: '三分线/折线目标' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { targetMode: v as 'detection' | 'polyline' }))}
              />
            </label>
            {(node.data.targetMode ?? 'detection') === 'polyline' && (
              <label>
                三分线折线点（JSON）
                <textarea
                  key={`${node.id}-polyline`}
                  rows={5}
                  defaultValue={JSON.stringify(node.data.targetPolyline ?? [], null, 2)}
                  placeholder={'[{"x":300,"y":700},{"x":500,"y":620},{"x":700,"y":700}]'}
                  onBlur={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value) as Array<{ x: number; y: number }>;
                      onChangeNode(updateNodeData(node, {
                        targetPolyline: parsed.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y)).map((point) => ({ x: Number(point.x), y: Number(point.y) })),
                      }));
                    } catch {
                      // Keep the last valid polyline when the textarea contains invalid JSON.
                    }
                  }}
                />
              </label>
            )}
            <label>
              世界坐标标定（JSON，可选）
              <textarea
                key={node.id}
                rows={8}
                defaultValue={JSON.stringify(node.data.calibration ?? { image: [], world: [], unit: 'm' }, null, 2)}
                placeholder={'{\n  "image": [{"x":0,"y":0}, {"x":100,"y":0}, {"x":100,"y":100}, {"x":0,"y":100}],\n  "world": [{"x":0,"y":0}, {"x":10,"y":0}, {"x":10,"y":10}, {"x":0,"y":10}],\n  "unit": "m"\n}'}
                onBlur={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value) as { image?: Array<{ x: number; y: number }>; world?: Array<{ x: number; y: number }>; unit?: string };
                    onChangeNode(updateNodeData(node, {
                      calibration: {
                        image: parsed.image ?? [],
                        world: parsed.world ?? [],
                        unit: parsed.unit ?? 'm',
                      },
                    }));
                  } catch {
                    // Keep the last valid calibration when the textarea contains invalid JSON.
                  }
                }}
              />
            </label>
            <p className="properties-panel__hint">
              至少填写 4 组对应点。图像点使用截图像素坐标，世界点使用目标平面坐标；执行器通过单应矩阵计算真实位置。
            </p>
          </section>
        )}

        {node.type === 'movePlayer' && (
          <section className="properties-panel__group">
            <h3>移动配置</h3>
            <label>
              执行方式
              <CustomSelect
                value={node.data.controlMode ?? 'continuous'}
                options={[
                  { value: 'continuous', label: '永久持续（逐帧检测，直到手动停止）' },
                  { value: 'pulse', label: '单次脉冲（兼容旧流程）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { controlMode: v as 'continuous' | 'pulse' }))}
              />
            </label>
            {(node.data.controlMode ?? 'continuous') === 'continuous' && (
              <p className="properties-panel__hint">
                每个检测帧都会更新动作：距离仍远时保持当前方向键，不再重复按下；进入停止距离或稳定到达时只释放输入并继续监测，之后距离变远会自动重新按住。闭环不会因到达自动结束。
              </p>
            )}
            {(node.data.controlMode ?? 'continuous') === 'continuous' && node.data.directionMode === 'auto' && (
              <label>
                空间检测节点
                <CustomSelect
                  value={node.data.detectorNodeId ?? ''}
                  options={[
                    { value: '', label: '自动使用最近的 Spatial Detector' },
                    ...allNodes.filter((item) => item.type === 'spatialDetector').map((item) => ({ value: item.id, label: item.title || item.id })),
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { detectorNodeId: v || undefined }))}
                />
              </label>
            )}
            <label>
              方向来源
              <CustomSelect
                value={node.data.directionMode}
                options={[
                  { value: 'auto', label: '自动：使用 Spatial Detector 方向' },
                  { value: 'manual', label: '手动指定方向' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { directionMode: v as 'auto' | 'manual' }))}
              />
            </label>
            {node.data.directionMode === 'manual' && (
              <label>
                移动方向
                <CustomSelect
                  value={node.data.direction}
                  options={[
                    { value: 'up', label: '上' },
                    { value: 'down', label: '下' },
                    { value: 'left', label: '左' },
                    { value: 'right', label: '右' },
                    { value: 'stop', label: '停止' },
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { direction: v as MoveDirection }))}
                />
              </label>
            )}
            <label>
              控制通道
              <CustomSelect
                value={node.data.control}
                options={[
                  { value: 'gamepad', label: '左摇杆方向' },
                  { value: 'gamepadAnalog', label: 'PS5 模拟摇杆' },
                  { value: 'keyboard', label: '键盘按键' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { control: v as 'gamepad' | 'gamepadAnalog' | 'keyboard' }))}
              />
            </label>
            <label>
              发送目标
              <CustomSelect
                value={node.data.target}
                options={[
                  { value: 'stream', label: '串流设备窗口' },
                  { value: 'global', label: '系统全局' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, {
                  target: v as 'global' | 'stream',
                  streamSourceId: v === 'stream' ? (node.data.streamSourceId ?? streamSources[0]?.id) : undefined,
                }))}
              />
            </label>
            {node.data.target === 'stream' && (
              <label>
                串流设备
                <CustomSelect
                  value={node.data.streamSourceId ?? ''}
                  options={[
                    { value: '', label: streamSources.length > 0 ? '未选择' : '尚未配置串流设备' },
                    ...streamSources.map((source) => ({ value: source.id, label: source.name || source.id })),
                  ]}
                  onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                />
              </label>
            )}
            {node.data.control === 'gamepadAnalog' && (
              <div className="grid-two">
                <label>
                  摇杆
                  <CustomSelect
                    value={node.data.stick ?? 'left'}
                    options={[{ value: 'left', label: '左摇杆' }, { value: 'right', label: '右摇杆' }]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { stick: v as 'left' | 'right' }))}
                  />
                </label>
                <label>
                  最大模拟量
                  <input type="number" min={0.1} max={1} step={0.05} value={node.data.maxStickMagnitude ?? 0.7} onChange={(e) => onChangeNode(updateNodeData(node, { maxStickMagnitude: Number(e.target.value) }))} />
                </label>
                <label>
                  最小模拟量
                  <input type="number" min={0.05} max={1} step={0.05} value={node.data.minStickMagnitude ?? 0.2} onChange={(e) => onChangeNode(updateNodeData(node, { minStickMagnitude: Number(e.target.value) }))} />
                </label>
                <label>
                  刹车距离
                  <input type="number" min={1} step={1} value={node.data.brakeDistance ?? 120} onChange={(e) => onChangeNode(updateNodeData(node, { brakeDistance: Number(e.target.value) }))} />
                </label>
              </div>
            )}
            {node.data.control === 'keyboard' && (
              <div className="grid-two">
                <label>
                  上
                  <input value={node.data.keyboardUp ?? ''} onChange={(e) => onChangeNode(updateNodeData(node, { keyboardUp: e.target.value }))} />
                </label>
                <label>
                  下
                  <input value={node.data.keyboardDown ?? ''} onChange={(e) => onChangeNode(updateNodeData(node, { keyboardDown: e.target.value }))} />
                </label>
                <label>
                  左
                  <input value={node.data.keyboardLeft ?? ''} onChange={(e) => onChangeNode(updateNodeData(node, { keyboardLeft: e.target.value }))} />
                </label>
                <label>
                  右
                  <input value={node.data.keyboardRight ?? ''} onChange={(e) => onChangeNode(updateNodeData(node, { keyboardRight: e.target.value }))} />
                </label>
              </div>
            )}
            {(node.data.controlMode ?? 'continuous') === 'continuous' ? (
              <label>
                停止距离（进入后释放按键并继续监测）
                <NumberInput
                  value={node.data.deadZone}
                  fallback={10}
                  min={0}
                  onChange={(value) => onChangeNode(updateNodeData(node, { deadZone: value }))}
                />
              </label>
            ) : (
              <div className="grid-two">
                <label>
                  停止距离
                  <NumberInput
                    value={node.data.deadZone}
                    fallback={10}
                    min={0}
                    onChange={(value) => onChangeNode(updateNodeData(node, { deadZone: value }))}
                  />
                </label>
                <label>
                  按键持续（ms）
                  <NumberInput
                    value={node.data.durationMs}
                    fallback={120}
                    min={0}
                    onChange={(value) => onChangeNode(updateNodeData(node, { durationMs: value }))}
                  />
                </label>
              </div>
            )}
            {(node.data.controlMode ?? 'continuous') === 'pulse' && (
              <label>
                后延迟（ms）
                <NumberInput
                  value={node.data.delayMs}
                  fallback={80}
                  min={0}
                  onChange={(value) => onChangeNode(updateNodeData(node, { delayMs: value }))}
                />
              </label>
            )}
            <label className="checkbox-row">
              <span>稳定到达时释放输入（持续闭环继续监测）</span>
              <input
                type="checkbox"
                checked={node.data.stopWhenArrived}
                onChange={(e) => onChangeNode(updateNodeData(node, { stopWhenArrived: e.target.checked }))}
              />
            </label>
          </section>
        )}


        {node.type === 'gamepad' && (
          <section className="properties-panel__group">
            <h3>手柄配置</h3>
            <label>
              手柄按键
              <CustomSelect
                value={node.data.action}
                options={[
                  { value: 'pressCross', label: '1 · 叉' },
                  { value: 'pressCircle', label: '2 · 圆圈' },
                  { value: 'pressTriangle', label: '3 · 三角' },
                  { value: 'pressSquare', label: '4 · 方框' },
                  { value: 'pressR2', label: 'R2' },
                  { value: 'pressL2', label: 'L2' },
                  { value: 'pressR1', label: 'R1' },
                  { value: 'pressL1', label: 'L1' },
                  { value: 'pressOptions', label: 'Options' },
                  { value: 'pressShare', label: 'Share' },
                  { value: 'pressPS', label: 'PS' },
                  { value: 'pressDPADU', label: '十字 ↑' },
                  { value: 'pressDPADD', label: '十字 ↓' },
                  { value: 'pressDPADL', label: '十字 ←' },
                  { value: 'pressDPADR', label: '十字 →' },
                  { value: 'pressLU', label: '左摇杆 ↑' },
                  { value: 'pressLD', label: '左摇杆 ↓' },
                  { value: 'pressLL', label: '左摇杆 ←' },
                  { value: 'pressLR', label: '左摇杆 →' },
                  { value: 'pressRU', label: '右摇杆 ↑' },
                  { value: 'pressRD', label: '右摇杆 ↓' },
                  { value: 'pressRL', label: '右摇杆 ←' },
                  { value: 'pressRR', label: '右摇杆 →' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { action: v as GamepadAction }))}
              />
            </label>
            <label>
              游戏内键盘按键（可选）
              <input
                value={node.data.keyboardKey ?? ''}
                maxLength={16}
                placeholder="例如：E / A / O / 1 / 2 / 5–0"
                onChange={(e) => onChangeNode(updateNodeData(node, { keyboardKey: e.target.value.trim() || undefined }))}
              />
            </label>
            <p className="properties-panel__hint">
              填写后优先发送这个精确按键，可自由设置 A–Z、0–9 或 E、O、1、2、5、6、7、8、9、0 等游戏按键；留空则使用下方 PS5 默认映射。
            </p>
            <label>
              发送目标
              <CustomSelect
                value={node.data.target ?? 'stream'}
                options={[
                  { value: 'stream', label: '串流设备窗口' },
                  { value: 'global', label: '系统全局' },
                ]}
                onChange={(v) => {
                  const target = v as 'global' | 'stream';
                  onChangeNode(updateNodeData(node, {
                    target,
                    streamSourceId: target === 'stream' ? (node.data.streamSourceId ?? streamSources[0]?.id) : undefined,
                    streamWindowHint: undefined,
                  }));
                }}
              />
            </label>
            {(node.data.target ?? 'stream') === 'stream' && (
              <>
                <label>
                  串流设备窗口
                  <CustomSelect
                    value={node.data.streamSourceId ?? ''}
                    options={[
                      { value: '', label: streamSources.length > 0 ? '未选择' : '尚未配置串流设备' },
                      ...streamSources.map((s) => ({ value: s.id, label: s.name || s.windowHint || s.id })),
                    ]}
                    onChange={(v) => onChangeNode(updateNodeData(node, {
                      streamSourceId: v || undefined,
                      streamWindowHint: undefined,
                    }))}
                  />
                </label>
                {(() => {
                  const selectedStream = streamSources.find((source) => source.id === node.data.streamSourceId);
                  return (
                    <p className="properties-panel__hint">
                      {!selectedStream
                        ? '请先在串流管理中配置设备，然后在这里选择它的窗口。'
                        : selectedStream.transport === 'ps5Direct'
                          ? `目标：${selectedStream.name || selectedStream.id}（PS5 协议直连，不依赖窗口焦点）`
                          : `目标窗口：${selectedStream.name || selectedStream.id}${selectedStream.windowHint ? ` · ${selectedStream.windowHint}` : '（尚未配置窗口标题）'}`}
                    </p>
                  );
                })()}
                <p className="properties-panel__hint">
                  窗口标题由所选串流设备统一配置，Gamepad 不再单独填写指定窗口。
                </p>
              </>
            )}
            <label>
              按键持续时间（毫秒）
              <NumberInput
                value={node.data.durationMs}
                fallback={120}
                min={0}
                max={10000}
                onChange={(value) => onChangeNode(updateNodeData(node, { durationMs: value }))}
              />
            </label>
            <label>
              按键后延迟（毫秒）
              <NumberInput
                value={node.data.delayMs}
                fallback={100}
                min={0}
                max={10000}
                onChange={(value) => onChangeNode(updateNodeData(node, { delayMs: value }))}
              />
            </label>
            {!isDirectStream(node.data.streamSourceId) && !node.data.keyboardKey?.trim() && (
              <>
            <label>
              使用CDP协议
              <CustomSelect
                value={node.data.useCdp ? 'true' : 'false'}
                options={[
                  { value: 'false', label: '否（使用键盘映射）' },
                  { value: 'true', label: '是（使用CDP协议）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { useCdp: v === 'true' }))}
              />
            </label>
            {node.data.useCdp && (
              <label>
                CDP调试端口
                <NumberInput
                  value={node.data.cdpPort}
                  fallback={9222}
                  min={1}
                  max={65535}
                  onChange={(value) => onChangeNode(updateNodeData(node, { cdpPort: value }))}
                />
              </label>
            )}
            <label>
              使用SharedMemory
              <CustomSelect
                value={node.data.useSharedMemory ? 'true' : 'false'}
                options={[
                  { value: 'false', label: '否（使用键盘映射）' },
                  { value: 'true', label: '是（使用SharedMemory）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { useSharedMemory: v === 'true' }))}
              />
            </label>
            {node.data.useSharedMemory && (
              <p className="properties-panel__hint">
                SharedMemory模式：通过共享内存直接发送手柄按键到Chiaki-ng，延迟更低。
              </p>
            )}
              </>
            )}
            <p className="properties-panel__hint">
              {node.data.keyboardKey?.trim() && isDirectStream(node.data.streamSourceId)
                ? '自定义键盘按键不能通过 PS5 协议直连发送；请改用外部串流窗口，或清空自定义按键后使用 PS5 手柄动作。'
                : node.data.keyboardKey?.trim()
                  ? `将向所选串流窗口发送键盘按键「${node.data.keyboardKey.trim()}」。`
                  : isDirectStream(node.data.streamSourceId)
                    ? 'PS5 直连设备：所有手柄动作直接发送到主机协议会话。'
                : node.data.useCdp
                  ? 'CDP协议：手柄按键直接发送到所选串流设备窗口，需要串流软件支持CDP调试端口'
                  : '键盘映射：手柄按键映射为键盘按键后发送到所选串流设备窗口'}
            </p>
          </section>
        )}

        {node.type === 'liveVision' && (
          <section className="properties-panel__group">
            <h3>实时检测配置</h3>
            <label>
              画面来源
              <CustomSelect
                value={node.data.source ?? 'stream'}
                options={[
                  { value: 'screen', label: '系统屏幕' },
                  { value: 'window', label: '本机指定窗口' },
                  { value: 'stream', label: '串流窗口' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { source: v as 'screen' | 'window' | 'stream' }))}
              />
            </label>

            {node.data.source === 'stream' && (
              <>
                <label>
                  串流设备
                  <CustomSelect
                    value={node.data.streamSourceId ?? ''}
                    options={[{ value: '', label: '未选择' }, ...streamSources.map((s) => ({ value: s.id, label: s.name || s.windowHint || s.id }))]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { streamSourceId: v || undefined }))}
                  />
                </label>
                <label>
                  串流窗口标题关键字（可选）
                  <input
                    value={node.data.windowHint ?? ''}
                    onChange={(e) => onChangeNode(updateNodeData(node, { windowHint: e.target.value }))}
                    placeholder="例如：PS Remote Play / Chiaki / Moonlight"
                  />
                </label>
              </>
            )}
            <div className="grid-two">
              <label>
                处理帧率
                <FrameRateSelect
                  value={node.data.fps}
                  sourceLabel="跟随串流/来源"
                  onChange={(value) => onChangeNode(updateNodeData(node, { fps: value }))}
                />
              </label>
              <label>
                检测超时（ms）
                <NumberInput
                  value={node.data.timeoutMs}
                  fallback={5000}
                  min={0}
                  step={100}
                  onChange={(value) => onChangeNode(updateNodeData(node, { timeoutMs: value }))}
                />
              </label>
            </div>
            <label>
              检测方式
              <CustomSelect
                value={node.data.detectMode ?? 'yolo'}
                options={[
                  { value: 'yolo', label: 'YOLO 检测' },
                  { value: 'template', label: '模板匹配' },
                  { value: 'both', label: 'YOLO + 模板' },
                  { value: 'ocr', label: 'OCR 文字定位' },
                  { value: 'all', label: 'YOLO + 模板 + OCR' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { detectMode: v as 'yolo' | 'template' | 'both' }))}
              />
            </label>
            {(node.data.detectMode === 'yolo' || node.data.detectMode === 'both' || node.data.detectMode === 'all') && (
              <>
                <label>
                  YOLO 模型
                  <ModelPicker
                    value={node.data.yoloModelPath}
                    onChange={(model) => onChangeNode(updateNodeData(node, { yoloModelPath: model.path }))}
                    refreshKey={yoloVersion ?? 0}
                  />
                </label>
                {onOpenYoloManager && (
                  <button className="properties-panel__ghost-button" onClick={onOpenYoloManager}>
                    管理模型…
                  </button>
                )}
                <label>
                  目标标签（可选）
                  <input
                    value={node.data.yoloLabel ?? ''}
                    onChange={(e) => onChangeNode(updateNodeData(node, { yoloLabel: e.target.value }))}
                    placeholder="留空表示匹配任意类别"
                  />
                </label>
                <label>
                  YOLO 置信阈值
                  <NumberInput
                    value={node.data.yoloThreshold}
                    fallback={60}
                    min={0}
                    max={100}
                    onChange={(value) => onChangeNode(updateNodeData(node, { yoloThreshold: value }))}
                  />
                </label>
              </>
            )}
            {(node.data.detectMode === 'ocr' || node.data.detectMode === 'all') && (
              <>
                <label>
                  OCR 目标文字
                  <input
                    value={node.data.ocrText ?? ''}
                    onChange={(e) => onChangeNode(updateNodeData(node, { ocrText: e.target.value }))}
                    placeholder="例如：开始、提交、Score"
                  />
                </label>
                <label>
                  OCR 引擎
                  <CustomSelect
                    value={node.data.ocrEngine ?? 'auto'}
                    options={[
                      { value: 'auto', label: '系统 OCR（自动）' },
                      { value: 'macosVision', label: 'macOS Vision' },
                      { value: 'tesseract', label: 'Tesseract' },
                    ]}
                    onChange={(v) => onChangeNode(updateNodeData(node, { ocrEngine: v as 'auto' | 'macosVision' | 'tesseract' }))}
                  />
                </label>
                <div className="grid-two">
                  <label>
                    OCR 语言
                    <CustomSelect
                      value={node.data.ocrLang ?? 'auto'}
                      options={[
                        { value: 'auto', label: '自动判断' },
                        { value: 'eng', label: '英文' },
                        { value: 'chi_sim', label: '中文' },
                      ]}
                      onChange={(v) => onChangeNode(updateNodeData(node, { ocrLang: v as 'auto' | 'eng' | 'chi_sim' }))}
                    />
                  </label>
                  <label>
                    OCR 置信阈值
                    <NumberInput
                      value={node.data.ocrThreshold}
                      fallback={60}
                      min={0}
                      max={100}
                      onChange={(value) => onChangeNode(updateNodeData(node, { ocrThreshold: value }))}
                    />
                  </label>
                </div>
              </>
            )}
            {/* 模板匹配配置 */}
            {(node.data.detectMode === 'template' || node.data.detectMode === 'both' || node.data.detectMode === 'all') && (
              <>
                <label>
                  匹配模板
                  <TemplatePicker
                    templates={templates}
                    folders={folders}
                    value={node.data.templatePath ?? ''}
                    onChange={(templateId) => {
                      const tpl = templates.find((t) => t.id === templateId);
                      onChangeNode(updateNodeData(node, { templatePath: tpl?.imageFile ? templateId : templateId }));
                    }}
                  />
                </label>
                <label>
                  模板置信阈值
                  <NumberInput
                    value={node.data.templateThreshold}
                    fallback={80}
                    min={0}
                    max={100}
                    onChange={(value) => onChangeNode(updateNodeData(node, { templateThreshold: value }))}
                  />
                </label>
                {onOpenTemplateManager && (
                  <button className="properties-panel__ghost-button" onClick={onOpenTemplateManager}>
                    管理模板…
                  </button>
                )}
              </>
            )}
            <label>
              检测到目标后
              <CustomSelect
                value={node.data.action ?? 'returnCoords'}
                options={[
                  { value: 'returnCoords', label: '返回坐标（交给后续节点处理）' },
                  { value: 'click', label: '直接点击检测到的目标' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { action: v as 'returnCoords' | 'click' }))}
              />
            </label>
            <p className="properties-panel__hint">实时检测按所选处理帧率持续读取画面；实际 FPS 受模型、画面来源和硬件性能限制。</p>
          </section>
        )}

        {node.type === 'recognize' && (
          <section className="properties-panel__group properties-panel__group--recognize" onWheel={(e) => e.stopPropagation()}>
            <h3>识别配置</h3>
            <p className="properties-panel__hint">Recognize（包括其中的 YOLO/模板/OCR 策略）每次执行只分析一帧，因此这里不设置 FPS；连续视频请使用 Live Vision 或 Spatial Detector。</p>
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
                              <NumberInput
                                value={strategy.x}
                                fallback={0}
                                onChange={(value) => updateStrategy('coords', { x: value })}
                              />
                            </label>
                            <label>
                              Y
                              <NumberInput
                                value={strategy.y}
                                fallback={0}
                                onChange={(value) => updateStrategy('coords', { y: value })}
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
                            <NumberInput
                              value={strategy.threshold}
                              fallback={60}
                              min={0}
                              max={100}
                              onChange={(value) => updateStrategy('template', { threshold: value })}
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
                            <NumberInput
                              value={strategy.threshold}
                              fallback={60}
                              min={0}
                              max={100}
                              onChange={(value) => updateStrategy('yolo', { threshold: value })}
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
                            <NumberInput
                              value={strategy.threshold}
                              fallback={60}
                              min={0}
                              max={100}
                              onChange={(value) => updateStrategy('ocr', { threshold: value })}
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
                            <NumberInput
                              value={strategy.threshold}
                              fallback={60}
                              min={0}
                              max={100}
                              onChange={(value) => updateStrategy('cloudApi', { threshold: value })}
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
