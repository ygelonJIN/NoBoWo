import type { RecognizeNode, TemplateDefinition, WorkflowNode } from '@nobowo/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CustomSelect } from './CustomSelect';
import { TemplatePicker } from './TemplatePicker';

type Props = {
  node: WorkflowNode | null;
  onChangeNode: (node: WorkflowNode) => void;
  templateVersion: number;
  onOpenTemplateManager: () => void;
};

type StrategyKey = 'coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi';

type LooseStrategy = {
  enabled: boolean;
  x?: number;
  y?: number;
  templateId?: string;
  threshold?: number;
  label?: string;
  text?: string;
  url?: string;
  apiKey?: string;
  prompt?: string;
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

export function PropertiesPanel({ node, onChangeNode, templateVersion, onOpenTemplateManager }: Props) {
  const [draggedStrategy, setDraggedStrategy] = useState<StrategyKey | null>(null);
  const [dragOverStrategy, setDragOverStrategy] = useState<StrategyKey | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    if (!window.templateAPI) {
      setTemplates([]);
      return;
    }
    window.templateAPI
      .list()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [templateVersion]);

  const handleDragStart = useCallback((e: React.DragEvent, strategy: StrategyKey) => {
    setDraggedStrategy(strategy);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', strategy);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, strategy: StrategyKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (strategy !== draggedStrategy) {
      setDragOverStrategy(strategy);
    }
  }, [draggedStrategy]);

  const handleDragEnter = useCallback((e: React.DragEvent, strategy: StrategyKey) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (strategy !== draggedStrategy) {
      setDragOverStrategy(strategy);
    }
  }, [draggedStrategy]);

  const handleDragLeave = useCallback((e: React.DragEvent, strategy: StrategyKey) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOverStrategy(null);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetStrategy: StrategyKey) => {
    e.preventDefault();
    setDragOverStrategy(null);
    dragCounterRef.current = 0;

    if (!node || node.type !== 'recognize' || !draggedStrategy || draggedStrategy === targetStrategy) {
      setDraggedStrategy(null);
      return;
    }

    const currentOrder = node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi'];
    const newOrder = [...currentOrder];
    const draggedIndex = newOrder.indexOf(draggedStrategy);
    const targetIndex = newOrder.indexOf(targetStrategy);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedStrategy(null);
      return;
    }

    // Remove dragged item and insert at target position
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedStrategy);

    onChangeNode(updateNodeData(node, { strategyOrder: newOrder }));
    setDraggedStrategy(null);
  }, [node, draggedStrategy, onChangeNode]);

  const handleDragEnd = useCallback(() => {
    setDraggedStrategy(null);
    setDragOverStrategy(null);
    dragCounterRef.current = 0;
  }, []);

  const moveStrategy = useCallback((strategy: StrategyKey, direction: -1 | 1) => {
    if (!node || node.type !== 'recognize') return;
    const order = [...(node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi'])];
    const idx = order.indexOf(strategy);
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];
    onChangeNode(updateNodeData(node, { strategyOrder: order }));
  }, [node, onChangeNode]);

  if (!node) {
    return <aside className="properties-panel"><div className="properties-panel__scroll">请选择一个节点</div></aside>;
  }

  return (
    <aside className="properties-panel">
      <div className="properties-panel__scroll">
      <div className="properties-panel__header">节点属性</div>
      <label>
        标题
        <input value={node.title} onChange={(e) => onChangeNode({ ...node, title: e.target.value })} />
      </label>
      <label>
        描述
        <textarea value={node.description ?? ''} onChange={(e) => onChangeNode({ ...node, description: e.target.value })} />
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
            <textarea value={node.data.value} onChange={(e) => onChangeNode(updateNodeData(node, { value: e.target.value }))} />
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
              options={[{ value: 'delay', label: '延时' }, { value: 'condition', label: '条件' }]}
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
              options={[{ value: 'full', label: '全屏' }, { value: 'selected', label: '选区' }]}
              onChange={(v) => onChangeNode(updateNodeData(node, { regionMode: v as 'full' | 'selected' }))}
            />
          </label>
        </section>
      )}

      {node.type === 'if' && (
        <section className="properties-panel__group">
          <h3>判断配置</h3>
          <label>
            表达式
            <input value={node.data.expression} onChange={(e) => onChangeNode(updateNodeData(node, { expression: e.target.value }))} />
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
              options={[{ value: 'count', label: '次数' }, { value: 'condition', label: '条件' }]}
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

      {node.type === 'recognize' && (
        <section className="properties-panel__group">
          <h3>识别配置</h3>
          <label>
            执行模式
            <CustomSelect
              value={node.data.executionMode}
              options={[{ value: 'cascade', label: '级联' }, { value: 'parallel', label: '并行' }]}
              onChange={(v) => onChangeNode(updateNodeData(node, { executionMode: v as 'cascade' | 'parallel' }))}
            />
          </label>


          
          {(node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi']).map((strategyKey: StrategyKey) => {
            const strategy = node.data.strategies[strategyKey] as LooseStrategy;
            const strategyNames: Record<StrategyKey, string> = {
              coords: '坐标回放',
              template: '模板匹配',
              yolo: 'YOLO',
              ocr: 'OCR',
              cloudApi: '云端API'
            };
            const strategyIndex = (node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi']).indexOf(strategyKey) + 1;

            return (
              <div
                key={strategyKey}
                className={`strategy-section ${draggedStrategy === strategyKey ? 'dragging' : ''} ${dragOverStrategy === strategyKey ? 'drag-over' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, strategyKey)}
                onDragOver={(e) => handleDragOver(e, strategyKey)}
                onDragEnter={(e) => handleDragEnter(e, strategyKey)}
                onDragLeave={(e) => handleDragLeave(e, strategyKey)}
                onDrop={(e) => handleDrop(e, strategyKey)}
                onDragEnd={handleDragEnd}
              >
                <div className="strategy-section__header">
                  <h4>策略{strategyIndex}: {strategyNames[strategyKey]}</h4>
                  <div className="strategy-section__arrows">
                    <button onClick={() => moveStrategy(strategyKey, -1)} disabled={strategyIndex <= 1}>↑</button>
                    <button onClick={() => moveStrategy(strategyKey, 1)} disabled={strategyIndex >= (node.data.strategyOrder || []).length}>↓</button>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={strategy.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    const newStrategies = { ...node.data.strategies };
                    switch (strategyKey) {
                      case 'coords':
                        newStrategies.coords = { ...newStrategies.coords, enabled };
                        break;
                      case 'template':
                        newStrategies.template = { ...newStrategies.template, enabled };
                        break;
                      case 'yolo':
                        newStrategies.yolo = { ...newStrategies.yolo, enabled };
                        break;
                      case 'ocr':
                        newStrategies.ocr = { ...newStrategies.ocr, enabled };
                        break;
                      case 'cloudApi':
                        newStrategies.cloudApi = { ...newStrategies.cloudApi, enabled };
                        break;
                    }
                    onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                  }}
                />
                {strategy.enabled && (
                  <>
                    {strategyKey === 'coords' && (
                      <div className="grid-two">
                        <label>
                          X
                          <input
                            type="number"
                            value={strategy.x}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], x: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          Y
                          <input
                            type="number"
                            value={strategy.y}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], y: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
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
                            value={strategy.templateId}
                            onChange={(templateId) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], templateId };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
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
                            value={strategy.threshold}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], threshold: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                      </>
                    )}
                    {strategyKey === 'yolo' && (
                      <>
                        <label>
                          标签
                          <input
                            value={strategy.label ?? ''}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], label: e.target.value };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          阈值
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={strategy.threshold}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], threshold: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                      </>
                    )}
                    {strategyKey === 'ocr' && (
                      <>
                        <label>
                          查找文字
                          <input
                            value={strategy.text}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], text: e.target.value };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          阈值
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={strategy.threshold}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], threshold: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                      </>
                    )}
                    {strategyKey === 'cloudApi' && (
                      <>
                        <label>
                          URL
                          <input
                            value={strategy.url}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], url: e.target.value };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          API Key
                          <input
                            type="password"
                            value={strategy.apiKey}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], apiKey: e.target.value };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          提示词
                          <textarea
                            value={strategy.prompt}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], prompt: e.target.value };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                        <label>
                          阈值
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={strategy.threshold}
                            onChange={(e) => {
                              const newStrategies = { ...node.data.strategies };
                              newStrategies[strategyKey] = { ...newStrategies[strategyKey], threshold: Number(e.target.value) };
                              onChangeNode(updateNodeData(node, { strategies: newStrategies }));
                            }}
                          />
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}

      <pre>{JSON.stringify(node.data, null, 2)}</pre>
      </div>
    </aside>
  );
}
