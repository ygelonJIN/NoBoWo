import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import {
  createDefaultNode,
  defaultWorkflowDocument,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from '@nobowo/core';
import { PropertiesPanel } from './components/PropertiesPanel';
import { TemplateManagerModal } from './components/TemplateManagerModal';
import { YoloManagerModal } from './components/YoloManagerModal';

const STORAGE_KEY = 'nobowo.workflow.document.v1';
const NODE_WIDTH = 220;
const NODE_HEIGHT = 86;
const HANDLE_SIZE = 22;
const SNAP_RADIUS = 54;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

type Point = { x: number; y: number };
type ContextMenu = { x: number; y: number };

const defaultSeedNodes: WorkflowNode[] = [createDefaultNode('click', 1), createDefaultNode('input', 2), createDefaultNode('wait', 3)];

function readInitialDocument(): WorkflowDocument {
  if (typeof window === 'undefined') {
    return { ...defaultWorkflowDocument(), nodes: defaultSeedNodes };
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { ...defaultWorkflowDocument(), nodes: defaultSeedNodes };
  }

  try {
    const parsed = JSON.parse(raw) as WorkflowDocument;
    if (parsed?.version === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      return parsed;
    }
  } catch {
    // invalid local data falls back to the starter workflow
  }

  return { ...defaultWorkflowDocument(), nodes: defaultSeedNodes };
}

function cloneNode(node: WorkflowNode, offset = 40): WorkflowNode {
  return {
    ...node,
    id: `${node.type}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    position: { x: node.position.x + offset, y: node.position.y + offset },
    title: `${node.title} copy`,
  };
}

function getSourcePoint(node: WorkflowNode): Point {
  return { x: node.position.x + (node.width ?? NODE_WIDTH), y: node.position.y + (node.height ?? NODE_HEIGHT) / 2 };
}

function getTargetPoint(node: WorkflowNode): Point {
  return { x: node.position.x, y: node.position.y + (node.height ?? NODE_HEIGHT) / 2 };
}

function getNodeBounds(node: WorkflowNode) {
  return {
    left: node.position.x,
    top: node.position.y,
    right: node.position.x + (node.width ?? NODE_WIDTH),
    bottom: node.position.y + (node.height ?? NODE_HEIGHT),
  };
}

function getConnectionSnap(nodes: WorkflowNode[], sourceId: string, point: Point, viewport: Point, zoom: number) {
  const canvasPoint = clientToCanvas(point, viewport, zoom);
  let nearest: WorkflowNode | null = null;
  let nearestDistance = SNAP_RADIUS;
  for (const node of nodes) {
    if (node.id === sourceId) continue;
    const target = getTargetPoint(node);
    const distance = Math.hypot(canvasPoint.x - target.x, canvasPoint.y - target.y);
    if (distance < nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }
  return nearest ? { node: nearest, targetPoint: getTargetPoint(nearest), distance: nearestDistance } : null;
}

function hasNodeOverlap(nodes: WorkflowNode[], activeNode: WorkflowNode) {
  const current = getNodeBounds(activeNode);
  return nodes.some((node) => {
    if (node.id === activeNode.id) return false;
    const bounds = getNodeBounds(node);
    return !(
      current.right < bounds.left ||
      current.left > bounds.right ||
      current.bottom < bounds.top ||
      current.top > bounds.bottom
    );
  });
}

function nodeAt(nodes: WorkflowNode[], point: Point, viewport: Point, zoom: number): WorkflowNode | null {
  const canvasPoint = {
    x: (point.x - viewport.x) / zoom,
    y: (point.y - viewport.y) / zoom,
  };

  return [...nodes].reverse().find((node) => {
    const width = node.width ?? NODE_WIDTH;
    const height = node.height ?? NODE_HEIGHT;
    return (
      canvasPoint.x >= node.position.x &&
      canvasPoint.x <= node.position.x + width &&
      canvasPoint.y >= node.position.y &&
      canvasPoint.y <= node.position.y + height
    );
  }) ?? null;
}

function clientToCanvas(point: Point, viewport: Point, zoom: number): Point {
  return { x: (point.x - viewport.x) / zoom, y: (point.y - viewport.y) / zoom };
}

function canvasToClient(point: Point, viewport: Point, zoom: number): Point {
  return { x: point.x * zoom + viewport.x, y: point.y * zoom + viewport.y };
}

export function App() {
  const initial = useMemo(readInitialDocument, []);
  const [nodes, setNodes] = useState<WorkflowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [clipboardNode, setClipboardNode] = useState<WorkflowNode | null>(null);
  const [isAutosaved, setIsAutosaved] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [templateVersion, setTemplateVersion] = useState(0);
  const [yoloManagerOpen, setYoloManagerOpen] = useState(false);
  const [yoloVersion, setYoloVersion] = useState(0);
  const [viewport, setViewport] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<{ id: string; offset: Point } | null>(null);
  const [panning, setPanning] = useState<{ start: Point; viewport: Point } | null>(null);
  const [connecting, setConnecting] = useState<{ sourceId: string; point: Point; snapTargetId?: string; sourceHandleId?: string; targetHandleId?: string } | null>(null);
  const [, setHistoryVersion] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const autosaveTimer = useRef<number | null>(null);
  const historyRef = useRef<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }[]>([]);
  const futureRef = useRef<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }[]>([]);
  const lastSnapshotRef = useRef(JSON.stringify({ nodes: initial.nodes, edges: initial.edges }));
  const previousStateRef = useRef({ nodes: initial.nodes, edges: initial.edges });
  const restoringHistoryRef = useRef(false);
  const isDraggingRef = useRef(false);
  const dragStartSnapshotRef = useRef<string | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  useEffect(() => {
    const snapshot = JSON.stringify({ nodes, edges });
    if (restoringHistoryRef.current || snapshot === lastSnapshotRef.current || isDraggingRef.current) return;
    historyRef.current.push(previousStateRef.current);
    if (historyRef.current.length > 50) historyRef.current.shift();
    futureRef.current = [];
    previousStateRef.current = { nodes, edges };
    lastSnapshotRef.current = snapshot;
    setHistoryVersion((version) => version + 1);
  }, [edges, nodes]);

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    futureRef.current.push({ nodes, edges });
    restoringHistoryRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setSelectedNodeId(null);
    setHistoryVersion((version) => version + 1);
    window.setTimeout(() => { restoringHistoryRef.current = false; }, 0);
  }, [edges, nodes]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    historyRef.current.push({ nodes, edges });
    restoringHistoryRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedNodeId(null);
    setHistoryVersion((version) => version + 1);
    window.setTimeout(() => { restoringHistoryRef.current = false; }, 0);
  }, [edges, nodes]);

  const markChanged = useCallback(() => {
    setIsAutosaved(false);
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = window.setTimeout(() => {
      const document: WorkflowDocument = { version: 1, nodes, edges };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document, null, 2));
      setIsAutosaved(true);
    }, 600);
  }, [edges, nodes]);

  useEffect(() => {
    markChanged();
    return () => {
      if (autosaveTimer.current) {
        window.clearTimeout(autosaveTimer.current);
      }
    };
  }, [edges, markChanged, nodes]);

  const getLocalPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }, []);

  const addNode = useCallback(
    (type: WorkflowNode['type'], point?: Point) => {
      const created = createDefaultNode(type, nodes.length + 1);
      const position = point ? clientToCanvas(point, viewport, zoom) : created.position;
      const nextNode = { ...created, position: { x: position.x - NODE_WIDTH / 2, y: position.y - 30 } };
      setNodes((current) => [...current, nextNode]);
      setSelectedNodeId(nextNode.id);
      setContextMenu(null);
    },
    [nodes.length, viewport, zoom],
  );

  const updateNode = useCallback((nextNode: WorkflowNode) => {
    setNodes((current) => current.map((node) => (node.id === nextNode.id ? nextNode : node)));
  }, []);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
    setContextMenu(null);
  }, [selectedNodeId]);

  const copySelectedNode = useCallback(() => {
    if (selectedNode) setClipboardNode(selectedNode);
    setContextMenu(null);
  }, [selectedNode]);

  const pasteNode = useCallback(() => {
    const source = clipboardNode ?? selectedNode;
    if (!source) return;
    const pasted = cloneNode(source);
    setNodes((current) => [...current, pasted]);
    setSelectedNodeId(pasted.id);
    setContextMenu(null);
  }, [clipboardNode, selectedNode]);

  const handleNodePointerDown = useCallback(
    (event: MouseEvent, node: WorkflowNode) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const point = getLocalPoint(event);
      const canvasPoint = clientToCanvas(point, viewport, zoom);
      setSelectedNodeId(node.id);
      isDraggingRef.current = true;
      dragStartSnapshotRef.current = JSON.stringify({ nodes, edges });
      setDragging({ id: node.id, offset: { x: canvasPoint.x - node.position.x, y: canvasPoint.y - node.position.y } });
    },
    [getLocalPoint, viewport, zoom, nodes, edges],
  );

  const handleSourcePointerDown = useCallback(
    (event: MouseEvent, node: WorkflowNode) => {
      event.stopPropagation();
      setConnecting({ sourceId: node.id, point: getLocalPoint(event), sourceHandleId: 'source', targetHandleId: 'target' });
    },
    [getLocalPoint],
  );

  const handlePointerMove = useCallback(
    (event: MouseEvent) => {
      const point = getLocalPoint(event);
      const hovered = nodeAt(nodes, point, viewport, zoom);
      setHoveredNodeId(hovered?.id ?? null);
      if (dragging) {
        const canvasPoint = clientToCanvas(point, viewport, zoom);
        setNodes((current) =>
          current.map((node) =>
            node.id === dragging.id
              ? { ...node, position: { x: canvasPoint.x - dragging.offset.x, y: canvasPoint.y - dragging.offset.y } }
              : node,
          ),
        );
      }
      if (panning) {
        setViewport({ x: panning.viewport.x + point.x - panning.start.x, y: panning.viewport.y + point.y - panning.start.y });
      }
      if (connecting) {
        const snap = getConnectionSnap(nodes, connecting.sourceId, point, viewport, zoom);
        setConnecting({ ...connecting, point, snapTargetId: snap?.node.id });
      }
    },
    [connecting, dragging, getLocalPoint, panning, viewport, zoom],
  );

  const handlePointerUp = useCallback(
    (event: MouseEvent) => {
      const point = getLocalPoint(event);
      if (connecting) {
        const snap = getConnectionSnap(nodes, connecting.sourceId, point, viewport, zoom);
        if (snap && snap.node.id !== connecting.sourceId) {
          setEdges((current) => {
            if (current.some((edge) => edge.source === connecting.sourceId && edge.target === snap.node.id)) return current;
            return [...current, { id: `edge-${Date.now()}`, source: connecting.sourceId, target: snap.node.id }];
          });
        }
      }
      if (dragging) {
        const moved = nodes.find((node) => node.id === dragging.id);
        if (moved) {
          setNodes((current) => current.map((node) => (node.id === moved.id ? node : node)));
        }
        if (dragStartSnapshotRef.current) {
          const currentSnapshot = JSON.stringify({ nodes, edges });
          if (dragStartSnapshotRef.current !== currentSnapshot) {
            const startState = JSON.parse(dragStartSnapshotRef.current);
            historyRef.current.push(startState);
            if (historyRef.current.length > 50) historyRef.current.shift();
            futureRef.current = [];
            previousStateRef.current = { nodes, edges };
            lastSnapshotRef.current = currentSnapshot;
            setHistoryVersion((version) => version + 1);
          }
        }
        isDraggingRef.current = false;
        dragStartSnapshotRef.current = null;
      }
      setDragging(null);
      setPanning(null);
      setConnecting(null);
    },
    [connecting, dragging, getLocalPoint, nodes, edges, viewport, zoom],
  );

  const handleCanvasPointerDown = useCallback(
    (event: MouseEvent) => {
      if (event.button !== 0) return;
      setContextMenu(null);
      if (event.target !== event.currentTarget) return;
      setSelectedNodeId(null);
      const point = getLocalPoint(event);
      setPanning({ start: point, viewport });
    },
    [getLocalPoint, viewport],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const point = getLocalPoint(event);
      const before = clientToCanvas(point, viewport, zoom);
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * (event.deltaY < 0 ? 1.1 : 0.9)));
      const nextPoint = canvasToClient(before, viewport, nextZoom);
      setViewport({ x: viewport.x + point.x - nextPoint.x, y: viewport.y + point.y - nextPoint.y });
      setZoom(nextZoom);
    },
    [getLocalPoint, viewport, zoom],
  );

  const zoomIn = useCallback(() => {
    const nextZoom = Math.min(MAX_ZOOM, zoom * 1.2);
    setZoom(nextZoom);
  }, [zoom]);

  const zoomOut = useCallback(() => {
    const nextZoom = Math.max(MIN_ZOOM, zoom / 1.2);
    setZoom(nextZoom);
  }, [zoom]);

  const exportWorkflow = useCallback(() => {
    const blob = new Blob([JSON.stringify({ version: 1, nodes, edges }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'workflow.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [edges, nodes]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelectedNode();
      } else if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteNode();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelectedNode();
      }
    },
    [copySelectedNode, deleteSelectedNode, pasteNode],
  );

  return (
    <div className={`app-shell ${selectedNode ? 'has-panel' : ''}`} onKeyDown={handleKeyDown} tabIndex={0}>
      <div
        className="canvas-area"
        ref={canvasRef}
        onMouseDown={handleCanvasPointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onWheel={handleWheel}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu(getLocalPoint(event));
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            setContextMenu(null);
            setSelectedNodeId(null);
          }
        }}
      >
        <div className="toolbar" onMouseDown={(event) => event.stopPropagation()}>
          <div className="toolbar__title">NoBoWo 工作流画布</div>
          <div className="toolbar__status-row">
            <div className="toolbar__status">
              <span className={`status-dot status-dot--${isAutosaved ? 'saved' : 'saving'}`} />
              {isAutosaved ? '已自动保存' : '正在保存...'}
            </div>
            <div className="toolbar__history">
              <button className="toolbar__icon-button" onClick={zoomOut} aria-label="缩小" title="缩小">−</button>
              <button className="toolbar__icon-button" onClick={zoomIn} aria-label="放大" title="放大">+</button>
              <button className="toolbar__icon-button" onClick={undo} disabled={historyRef.current.length === 0} aria-label="后退" title="后退">←</button>
              <button className="toolbar__icon-button" onClick={redo} disabled={futureRef.current.length === 0} aria-label="前进" title="前进">→</button>
            </div>
          </div>
          <div className="toolbar__actions">
            {(['recognize', 'click', 'input', 'wait', 'screenshot', 'if', 'loop'] as WorkflowNode['type'][]).map((type) => (
              <button key={type} onClick={() => addNode(type)}>{type}</button>
            ))}
            <button onClick={exportWorkflow}>导出</button>
          </div>
        </div>

          <div className="toolbar-tools" onMouseDown={(event) => event.stopPropagation()}>
          <div className="toolbar-tools__title">工具</div>
          <div className="toolbar-tools__actions">
            <button onClick={() => setYoloManagerOpen(true)}>YOLO 训练</button>
            <button onClick={() => setTemplateManagerOpen(true)}>模板管理</button>
          </div>
        </div>

        <svg className="workflow-edges" width="100%" height="100%">
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${zoom})`}>
            {edges.map((edge) => {
              const source = nodes.find((node) => node.id === edge.source);
              const target = nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const start = getSourcePoint(source);
              const end = getTargetPoint(target);
              return <path key={edge.id} className="workflow-edge" d={`M ${start.x} ${start.y} C ${start.x + 80} ${start.y}, ${end.x - 80} ${end.y}, ${end.x} ${end.y}`} />;
            })}
            {connecting && (() => {
              const source = nodes.find((node) => node.id === connecting.sourceId);
              if (!source) return null;
              const start = getSourcePoint(source);
              const snappedTarget = connecting.snapTargetId ? nodes.find((node) => node.id === connecting.snapTargetId) : null;
              const end = snappedTarget ? getTargetPoint(snappedTarget) : clientToCanvas(connecting.point, viewport, zoom);
              return <path className="workflow-edge workflow-edge--draft" d={`M ${start.x} ${start.y} C ${start.x + 80} ${start.y}, ${end.x - 80} ${end.y}, ${end.x} ${end.y}`} />;
            })()}
          </g>
        </svg>

        <div className="workflow-nodes" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${zoom})` }}>
          {nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const isHovered = hoveredNodeId === node.id;
            const isSnapTarget = connecting?.snapTargetId === node.id;
            const isOverlapping = hasNodeOverlap(nodes, node);
            const zIndex = isSelected ? 40 : isSnapTarget ? 35 : isHovered ? 30 : isOverlapping ? 20 : nodes.indexOf(node);

            return (
            <div
              key={node.id}
              className={`workflow-node workflow-node--${node.type} ${isSelected ? 'workflow-node--selected' : ''} ${isHovered ? 'workflow-node--hovered' : ''} ${isSelected && isHovered ? 'workflow-node--selected-hovered' : ''} ${isSnapTarget ? 'workflow-node--snap-target' : ''} ${isOverlapping ? 'workflow-node--overlap' : ''}`}
              style={{ left: node.position.x, top: node.position.y, width: node.width ?? NODE_WIDTH, height: node.height ?? NODE_HEIGHT, zIndex }}
              onMouseDown={(event) => handleNodePointerDown(event, node)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedNodeId(node.id);
                setContextMenu(getLocalPoint(event));
              }}
            >
              <div className="workflow-node__title">{node.title}</div>
              {node.type === 'recognize' ? (
                <div className={`workflow-node__strategies workflow-node__strategies--${node.data.executionMode}`}>
                  {(node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi'])
                    .filter((key: string) => (node.data.strategies as any)[key].enabled)
                    .map((key: string, index: number) => {
                      return <span key={key} className="workflow-node__strategy-badge">{index + 1}</span>;
                    })}
                </div>
              ) : (
                <div className="workflow-node__body">{node.description ?? '未配置'}</div>
              )}
              <button
                className={`node-handle node-handle--source ${connecting?.snapTargetId === node.id ? 'node-handle--snap' : ''}`}
                aria-label="连接输出"
                onMouseDown={(event) => handleSourcePointerDown(event, node)}
              />
              <span className={`node-handle node-handle--target ${isSnapTarget ? 'node-handle--snap' : ''}`} aria-hidden="true" />
            </div>
            );
          })}
        </div>

        {contextMenu && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
            <button onClick={copySelectedNode} disabled={!selectedNode}>复制节点</button>
            <button onClick={pasteNode} disabled={!clipboardNode && !selectedNode}>粘贴节点</button>
            <button onClick={deleteSelectedNode} disabled={!selectedNode}>删除节点</button>
          </div>
        )}
      </div>
      {selectedNode && (
        <PropertiesPanel
          node={selectedNode}
          onChangeNode={updateNode}
          templateVersion={templateVersion}
          onOpenTemplateManager={() => setTemplateManagerOpen(true)}
        />
      )}
      {templateManagerOpen && (
        <TemplateManagerModal
          onClose={() => setTemplateManagerOpen(false)}
          onChanged={() => setTemplateVersion((version) => version + 1)}
        />
      )}
      {yoloManagerOpen && (
        <YoloManagerModal
          onClose={() => setYoloManagerOpen(false)}
          onChanged={() => setYoloVersion((version) => version + 1)}
        />
      )}
    </div>
  );
}

