import type { CloudApiProfile, OcrEngine, RecognizeNode, StreamSourceProfile, TemplateDefinition, TemplateFolder, WorkflowNode } from '@nobowo/core';
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
  onOpenOcrTest: (preset?: { text?: string; engine?: OcrEngine }) => void;
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

export function PropertiesPanel({
  node,
  onChangeNode,
  style,
  templateVersion,
  cloudApiVersion = 0,
  onOpenTemplateManager,
  onOpenCloudApiManager,
  onOpenOcrTest,
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

        {node.type === 'input' && (
          <section className="properties-panel__group">
            <h3>输入配置</h3>
            <label>
              值
              <textarea
                value={node.data.value}
                onChange={(e) => onChangeNode(updateNodeData(node, { value: e.target.value }))}
              />
            </label>
            <label className="checkbox-row">
              <span>回车提交</span>
              <input
                type="checkbox"
                checked={node.data.submit ?? false}
                onChange={(e) => onChangeNode(updateNodeData(node, { submit: e.target.checked }))}
              />
            </label>
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
                  { value: 'stream', label: '串流窗口' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { source: v as 'screen' | 'stream' }))}
              />
            </label>
            {node.data.source === 'stream' && (
              <label>
                串流设备
                <CustomSelect
                  value={node.data.streamSourceId ?? ''}
                  options={[
                    { value: '', label: streamSourceLoading ? '正在加载串流设备…' : '选择一个串流设备' },
                    ...streamSources.map((source) => ({ value: source.id, label: `${source.name} · ${source.type.toUpperCase()}` })),
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
          </section>
        )}

        {node.type === 'scroll' && (
          <section className="properties-panel__group">
            <h3>滚动配置</h3>
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
              滚动距离（px）
              <input
                type="number"
                min={0}
                value={node.data.amount}
                onChange={(e) => onChangeNode(updateNodeData(node, { amount: Math.max(0, Number(e.target.value)) }))}
              />
            </label>
            <p className="properties-panel__hint">执行时对当前激活窗口滚动指定像素</p>
          </section>
        )}

        {node.type === 'keyboard' && (
          <section className="properties-panel__group">
            <h3>键盘配置</h3>
            <label>
              按键
              <input
                value={node.data.keys}
                placeholder="例如：enter / ctrl+shift+a / F5"
                onChange={(e) => onChangeNode(updateNodeData(node, { keys: e.target.value }))}
              />
            </label>
            <label>
              模式
              <CustomSelect
                value={node.data.mode}
                options={[
                  { value: 'tap', label: '点击（按下并松开）' },
                  { value: 'hold', label: '按住（长按）' },
                ]}
                onChange={(v) => onChangeNode(updateNodeData(node, { mode: v as 'tap' | 'hold' }))}
              />
            </label>
            <p className="properties-panel__hint">多个按键用 + 连接，如 ctrl+shift+a</p>
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
                          <button
                            className="properties-panel__ghost-button"
                            onClick={() => onOpenOcrTest({ text: strategy.text ?? '', engine: strategy.engine ?? 'auto' })}
                          >
                            测试台验证
                          </button>
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
              <div className="properties-panel__recognize-spacer" aria-hidden="true" />
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}