import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type WheelEvent } from 'react';
import {
  createDefaultNode,
  defaultWorkflowDocument,
  type OcrEngine,
  type RecognizeNode,
  type WorkflowDocument,
  type WorkflowEdge,
  type WorkflowNode,
} from '@nobowo/core';
import { PropertiesPanel } from './components/PropertiesPanel';
import { TemplateManagerModal, GlobalEnvModal } from './components/TemplateManagerModal';
import { YoloManagerModal } from './components/YoloManagerModal';
import { CloudApiManagerModal } from './components/CloudApiManagerModal';
import { OcrTestModal } from './components/OcrTestModal';
import { StreamManagerModal } from './components/StreamManagerModal';
import { DebugPanel } from './components/DebugPanel';
import { RecognizeTestModal } from './components/RecognizeTestModal';
import type { WorkflowRunSnapshot } from '@nobowo/core';

const STORAGE_KEY = 'nobowo.workflow.document.v1';
const NODE_WIDTH = 220;
const NODE_HEIGHT = 86;
const HANDLE_SIZE = 22;
const SNAP_RADIUS = 54;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const PANEL_WIDTH = 320;
const PANEL_GAP = 14;

type Point = { x: number; y: number };
type ContextMenu = { x: number; y: number; edgeId?: string };

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

function getSourcePoint(node: WorkflowNode, portId?: string): Point {
  const height = node.height ?? NODE_HEIGHT;
  let y: number;
  if (node.type === 'if' && portId === 'true') {
    y = node.position.y + height * 0.25;
  } else if (node.type === 'if' && portId === 'false') {
    y = node.position.y + height * 0.75;
  } else {
    y = node.position.y + height / 2;
  }
  return { x: node.position.x + (node.width ?? NODE_WIDTH), y };
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

function getNodeSummary(node: WorkflowNode): string {
  switch (node.type) {
    case 'click':
      return '点击识别到的目标';
    case 'input':
      return node.data.value ? `输入：${node.data.value}` : '空输入';
    case 'wait':
      return node.data.mode === 'delay' ? `延时 ${node.data.delayMs ?? 1000}ms` : '条件等待';
    case 'screenshot':
      if (node.data.source === 'stream') {
        return `串流窗口截图 · ${node.data.regionMode === 'full' ? '全屏' : '选区'}`;
      }
      if (node.data.source === 'window') {
        return `本机窗口截图${node.data.windowHint ? ` · ${node.data.windowHint}` : ''}`;
      }
      return node.data.regionMode === 'full'
        ? '全屏截图'
        : '选区截图';
    case 'if':
      return node.data.expression || '条件判断';
    case 'loop':
      return node.data.mode === 'count' ? `循环 ${node.data.count ?? 3} 次` : '条件循环';
    case 'scroll':
      return `滚动${directionLabel(node.data.direction)} ${node.data.amount}px`;
    case 'keyboard':
      return node.data.keys ? `按键：${node.data.keys}` : '空按键';
    case 'recognize':
      return '';
  }
}

function directionLabel(direction: string): string {
  switch (direction) {
    case 'up':
      return '向上';
    case 'down':
      return '向下';
    case 'left':
      return '向左';
    case 'right':
      return '向右';
    default:
      return direction;
  }
}

export function App() {
  const initial = useMemo(readInitialDocument, []);
  const [nodes, setNodes] = useState<WorkflowNode[]>(initial.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(initial.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [clipboardNode, setClipboardNode] = useState<WorkflowNode | null>(null);
  const [isAutosaved, setIsAutosaved] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [globalEnvOpen, setGlobalEnvOpen] = useState(false);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [templateVersion, setTemplateVersion] = useState(0);
  const [yoloManagerOpen, setYoloManagerOpen] = useState(false);
  const [yoloVersion, setYoloVersion] = useState(0);
  const [cloudApiManagerOpen, setCloudApiManagerOpen] = useState(false);
  const [cloudApiVersion, setCloudApiVersion] = useState(0);
  const [ocrTestOpen, setOcrTestOpen] = useState(false);
  const [ocrTestPreset, setOcrTestPreset] = useState<{ text?: string; engine?: OcrEngine } | null>(null);
  const [recognizeTestOpen, setRecognizeTestOpen] = useState(false);
  const [recognizeTestPreset, setRecognizeTestPreset] = useState<{
    strategies: RecognizeNode['data']['strategies'];
    strategyOrder: RecognizeNode['data']['strategyOrder'];
  } | null>(null);
  const [streamManagerOpen, setStreamManagerOpen] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [workflowRunState, setWorkflowRunState] = useState<WorkflowRunSnapshot | null>(null);
  const [workflowRunLogs, setWorkflowRunLogs] = useState<string[]>([]);
  const [workflowRunNotice, setWorkflowRunNotice] = useState<{ main: string; hint?: string } | null>(null);
  const nodesRef = useRef(nodes);
  const [viewport, setViewport] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panelHeight, setPanelHeight] = useState(0);
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offset: Point; start: Point; moved: boolean } | null>(null);
  const [panning, setPanning] = useState<{ start: Point; viewport: Point } | null>(null);
  const [connecting, setConnecting] = useState<{ sourceId: string; point: Point; snapTargetId?: string; sourceHandleId?: string; targetHandleId?: string } | null>(null);
  const [, setHistoryVersion] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autosaveTimer = useRef<number | null>(null);
  const historyRef = useRef<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }[]>([]);
  const futureRef = useRef<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }[]>([]);
  const lastSnapshotRef = useRef(JSON.stringify({ nodes: initial.nodes, edges: initial.edges }));
  const previousStateRef = useRef({ nodes: initial.nodes, edges: initial.edges });
  const restoringHistoryRef = useRef(false);
  const isDraggingRef = useRef(false);
  const dragStartSnapshotRef = useRef<string | null>(null);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const closeDebugPanel = useCallback(() => {
    setDebugPanelOpen(false);
  }, []);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    if (!window.workflowAPI) return;
    let active = true;
    window.workflowAPI.getState().then((state) => {
      if (active) setWorkflowRunState(state);
    }).catch(() => {});
    const off = window.workflowAPI.onEvent((event) => {
      if (event.t === 'start') {
        setWorkflowRunLogs([`[${new Date().toLocaleTimeString()}] 开始运行（${event.nodeCount} 个节点）`]);
      } else if (event.t === 'log') {
        setWorkflowRunLogs((current) => [...current.slice(-199), `[${new Date().toLocaleTimeString()}] ${event.message}`]);
      } else if (event.t === 'nodeStart') {
        const node = nodesRef.current.find((item) => item.id === event.nodeId);
        setWorkflowRunLogs((current) => [...current.slice(-199), `[${new Date().toLocaleTimeString()}] 执行节点：${node?.title ?? event.nodeId}`]);
      } else if (event.t === 'nodeEnd') {
        const node = nodesRef.current.find((item) => item.id === event.nodeId);
        const message = event.result.message ?? event.result.status;
        setWorkflowRunLogs((current) => [...current.slice(-199), `[${new Date().toLocaleTimeString()}] ${node?.title ?? event.nodeId} → ${message}`]);
      }
      setWorkflowRunState((current) => {
        const base = current ?? { runId: null, status: 'idle', startedAt: null, nodeStates: {}, nodeResults: {} };
        if (event.t === 'start') {
          setWorkflowRunNotice(null);
          return { runId: event.runId, status: 'running', startedAt: Date.now(), nodeStates: {}, nodeResults: {} };
        }
        if (event.t === 'nodeStart') {
          return { ...base, nodeStates: { ...base.nodeStates, [event.nodeId]: 'running' } };
        }
        if (event.t === 'nodeEnd') {
          return {
            ...base,
            nodeStates: { ...base.nodeStates, [event.nodeId]: event.result.status },
            nodeResults: { ...base.nodeResults, [event.nodeId]: event.result },
          };
        }
        if (event.t === 'pause') {
          setWorkflowRunNotice(null);
          return { ...base, status: 'paused' };
        }
        if (event.t === 'resume') {
          setWorkflowRunNotice(null);
          return { ...base, status: 'running' };
        }
        if (event.t === 'stopped') {
          setWorkflowRunNotice(null);
          return { ...base, status: 'stopped' };
        }
        if (event.t === 'done') {
          setWorkflowRunNotice(null);
          return { ...base, status: 'done' };
        }
        return base;
      });
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const floatingPanelStyle = useMemo<CSSProperties | null>(() => {
    if (!selectedNode) return null;
    const canvas = canvasRef.current;
    const clientWidth = canvas?.clientWidth ?? window.innerWidth;
    const clientHeight = canvas?.clientHeight ?? window.innerHeight;
    const nodeWidth = selectedNode.width ?? NODE_WIDTH;
    const nodeLeft = selectedNode.position.x * zoom + viewport.x;
    const nodeTop = selectedNode.position.y * zoom + viewport.y;
    const maxPanelHeight = Math.min(clientHeight - 32, 640);
    let left = nodeLeft + nodeWidth + PANEL_GAP;
    if (left + PANEL_WIDTH > clientWidth - 8) {
      left = Math.max(8, nodeLeft - PANEL_WIDTH - PANEL_GAP);
    }
    const top = Math.min(Math.max(8, nodeTop), Math.max(8, clientHeight - maxPanelHeight - 8));
    return {
      left,
      top,
      maxHeight: maxPanelHeight,
      '--panel-left': `${left}px`,
      '--panel-top': `${top}px`,
    } as CSSProperties;
  }, [selectedNode, viewport, zoom]);

  useLayoutEffect(() => {
    const el = panelAnchorRef.current;
    if (!el) {
      return;
    }
    const update = () => setPanelHeight(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectedNodeId]);

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

  const workflowRunPercent = useMemo(() => {
    if (!workflowRunState) return 0;
    const states = workflowRunState.nodeStates;
    const doneCount = Object.values(states).filter((state) => state === 'ok' || state === 'skipped').length;
    const total = nodes.length || Object.keys(states).length;
    return total === 0 ? 0 : Math.round((doneCount / total) * 100);
  }, [workflowRunState, nodes.length]);

  const updateNode = useCallback((nextNode: WorkflowNode) => {
    setNodes((current) => current.map((node) => (node.id === nextNode.id ? nextNode : node)));
  }, []);

  /** 测试台命中坐标 → 写回当前 recognize 节点的 coords 策略 */
  const applyRecognizeCoords = useCallback(
    (coords: { x: number; y: number }) => {
      const node = selectedNode;
      if (!node || node.type !== 'recognize') return;
      updateNode({
        ...node,
        data: {
          ...node.data,
          strategies: {
            ...node.data.strategies,
            coords: { ...node.data.strategies.coords, x: coords.x, y: coords.y, enabled: true },
          },
        },
      });
    },
    [selectedNode, updateNode],
  );

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
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      closeDebugPanel();
      isDraggingRef.current = true;
      dragStartSnapshotRef.current = JSON.stringify({ nodes, edges });
      setDragging({ id: node.id, offset: { x: canvasPoint.x - node.position.x, y: canvasPoint.y - node.position.y }, start: point, moved: false });
    },
    [getLocalPoint, viewport, zoom, nodes, edges, closeDebugPanel],
  );

  const handleSourcePointerDown = useCallback(
    (event: MouseEvent, node: WorkflowNode, sourceHandleId = 'out') => {
      event.stopPropagation();
      setConnecting({ sourceId: node.id, point: getLocalPoint(event), sourceHandleId, targetHandleId: 'in' });
    },
    [getLocalPoint],
  );

  const handleEdgePointerDown = useCallback((event: React.MouseEvent, edgeId: string) => {
    event.stopPropagation();
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(null);
    closeDebugPanel();
  }, []);

  const handlePointerMove = useCallback(
    (event: MouseEvent) => {
      const point = getLocalPoint(event);
      const hovered = nodeAt(nodes, point, viewport, zoom);
      setHoveredNodeId(hovered?.id ?? null);
      if (dragging) {
        const moved = dragging.moved || Math.hypot(point.x - dragging.start.x, point.y - dragging.start.y) > 6;
        if (moved !== dragging.moved) {
          setDragging({ ...dragging, moved });
        }
        if (moved) {
          setSelectedNodeId(null);
          const canvasPoint = clientToCanvas(point, viewport, zoom);
          setNodes((current) =>
            current.map((node) =>
              node.id === dragging.id
                ? { ...node, position: { x: canvasPoint.x - dragging.offset.x, y: canvasPoint.y - dragging.offset.y } }
                : node,
            ),
          );
        }
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
            if (current.some((edge) => edge.source === connecting.sourceId && edge.target === snap.node.id && edge.sourcePort === connecting.sourceHandleId)) return current;
            const sourcePort = connecting.sourceHandleId !== 'out' ? connecting.sourceHandleId : undefined;
            return [...current, { id: `edge-${Date.now()}`, source: connecting.sourceId, sourcePort, target: snap.node.id, targetPort: 'in' }];
          });
        }
      }
      if (dragging) {
        const movedNode = nodes.find((node) => node.id === dragging.id);
        if (movedNode) {
          setNodes((current) => current.map((node) => (node.id === movedNode.id ? node : node)));
        }
        if (!dragging.moved) {
          setSelectedNodeId(dragging.id);
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
      setSelectedEdgeId(null);
      closeDebugPanel();
      if (event.target !== event.currentTarget) return;
      setSelectedNodeId(null);
      setDebugPanelOpen(false);
      const point = getLocalPoint(event);
      setPanning({ start: point, viewport });
    },
    [getLocalPoint, viewport],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement | null)?.closest('.properties-panel-anchor, .debug-panel')) return;
      event.preventDefault();
      setSelectedNodeId(null);
      closeDebugPanel();
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

  const runWorkflow = useCallback(async () => {
    setDebugPanelOpen(true);
    if (!window.workflowAPI) {
      setWorkflowRunNotice({
        main: '当前环境没有工作流执行器',
        hint: '请在桌面版中运行，若已打开应用请先完全退出再重新启动',
      });
      return;
    }
    const result = await window.workflowAPI.run({ version: 1, nodes, edges });
    if (!result.started) {
      setWorkflowRunNotice({ main: result.message ?? '工作流启动失败', hint: '已有工作流在执行中，可在控制面板点击「继续」或「停止」' });
    } else {
      setWorkflowRunNotice(null);
    }
  }, [edges, nodes]);

  const pauseWorkflow = useCallback(() => {
    void window.workflowAPI?.pause();
  }, []);

  const resumeWorkflow = useCallback(() => {
    void window.workflowAPI?.resume();
  }, []);

  const stopWorkflow = useCallback(() => {
    void window.workflowAPI?.stop();
  }, []);

  const importWorkflow = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as WorkflowDocument;
        if (parsed?.version === 1 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
          setNodes(parsed.nodes);
          setEdges(parsed.edges);
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
          setContextMenu(null);
          historyRef.current = [];
          futureRef.current = [];
          const snapshot = JSON.stringify(parsed);
          lastSnapshotRef.current = snapshot;
          previousStateRef.current = { nodes: parsed.nodes, edges: parsed.edges };
        } else {
          window.alert('无法识别的文件格式，请选择导出的 workflow.json');
        }
      } catch {
        window.alert('文件解析失败，请选择导出的 workflow.json');
      }
    };
    reader.readAsText(file);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inFormField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (inFormField) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelectedNode();
      } else if (meta && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteNode();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (selectedEdgeId) {
          setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
          setSelectedEdgeId(null);
        } else {
          deleteSelectedNode();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelectedNode, deleteSelectedNode, pasteNode, selectedEdgeId]);

  return (
    <div className={`app-shell ${selectedNode ? 'has-panel' : ''}`} tabIndex={0}>
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
            closeDebugPanel();
          }
        }}
      >
        <div className="toolbar-left" onMouseDown={(event) => event.stopPropagation()}>
          <div className="toolbar-row">
            <div className="toolbar-run-card">
              <div className="toolbar-run-card__title-row">
                <div className="toolbar-run-card__title">控制面板</div>
                <div className="toolbar-run-card__status">
                  <span className={`status-dot status-dot--${workflowRunState?.status === 'running' ? 'saving' : 'saved'}`} />
                  {workflowRunState?.status === 'running'
                    ? '工作流运行中'
                    : workflowRunState?.status === 'paused'
                      ? '工作流已暂停'
                      : '工作流待命'}
                </div>
                <div className="toolbar-run-card__progress">
                  {workflowRunPercent}%
                </div>
              </div>
              
              <div className="toolbar-run-card__actions">
                <button className="toolbar-run-card__primary" onClick={runWorkflow}>运行</button>
                <button onClick={pauseWorkflow} disabled={workflowRunState?.status !== 'running'}>暂停</button>
                <button onClick={resumeWorkflow} disabled={workflowRunState?.status !== 'paused'}>继续</button>
                <button onClick={stopWorkflow} disabled={workflowRunState?.status === 'idle' || workflowRunState?.status === 'done'}>停止</button>
              </div>
            </div>

            <div className="toolbar-tools">
              <div className="toolbar-tools__title">工具配置</div>
              <div className="toolbar-tools__actions">
                <button onClick={() => setGlobalEnvOpen(true)}>全局环境依赖</button>
                <button onClick={() => setYoloManagerOpen(true)}>YOLO 训练</button>
                <button onClick={() => setTemplateManagerOpen(true)}>模板管理</button>
                <button onClick={() => { setOcrTestPreset(null); setOcrTestOpen(true); }}>OCR 测试台</button>
                <button onClick={() => setCloudApiManagerOpen(true)}>云端 API</button>
                <button onClick={() => setStreamManagerOpen(true)}>串流设备</button>
              </div>
            </div>

            <div className="toolbar">
              <div className="toolbar__top">
                <div className="toolbar__title">NoBoWo 节点配置</div>
                <div className="toolbar__status">
                  <span className={`status-dot status-dot--${isAutosaved ? 'saved' : 'saving'}`} />
                  {isAutosaved ? '已自动保存' : '正在保存...'}
                </div>
                <button
                  className={`toolbar__debug-btn ${debugPanelOpen ? 'toolbar__debug-btn--active' : ''}`}
                  onClick={() => setDebugPanelOpen((open) => !open)}
                >
                  调试面板
                </button>
                <div className="toolbar__history">
                  <button className="toolbar__icon-button" onClick={zoomOut} aria-label="缩小" title="缩小">−</button>
                  <button className="toolbar__icon-button" onClick={zoomIn} aria-label="放大" title="放大">+</button>
                  <button className="toolbar__icon-button" onClick={undo} disabled={historyRef.current.length === 0} aria-label="后退" title="后退">←</button>
                  <button className="toolbar__icon-button" onClick={redo} disabled={futureRef.current.length === 0} aria-label="前进" title="前进">→</button>
                </div>
              </div>
              <div className="toolbar__actions">
                {(['recognize', 'click', 'input', 'wait', 'screenshot', 'if', 'loop', 'scroll', 'keyboard'] as WorkflowNode['type'][]).map((type) => (
                  <button key={type} onClick={() => addNode(type)}>{type}</button>
                ))}
                <button onClick={exportWorkflow}>导出</button>
                <button onClick={() => fileInputRef.current?.click()}>导入</button>
              </div>
            </div>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importWorkflow(file);
            event.target.value = '';
          }}
        />

        <svg className="workflow-edges" width="100%" height="100%">
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${zoom})`}>
            {edges.map((edge) => {
              const source = nodes.find((node) => node.id === edge.source);
              const target = nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const start = getSourcePoint(source, edge.sourcePort);
              const end = getTargetPoint(target);
              const isSelected = selectedEdgeId === edge.id;
              const isDisabled = source.enabled === false || target.enabled === false;
              const branchClass =
                source.type === 'if' && edge.sourcePort === 'true'
                  ? 'workflow-edge--branch-true'
                  : source.type === 'if' && edge.sourcePort === 'false'
                    ? 'workflow-edge--branch-false'
                    : '';
              const d = `M ${start.x} ${start.y} C ${start.x + 80} ${start.y}, ${end.x - 80} ${end.y}, ${end.x} ${end.y}`;
              return (
                <g key={edge.id} className={`workflow-edge-group ${isSelected ? 'workflow-edge-group--selected' : ''} ${isDisabled ? 'workflow-edge-group--disabled' : ''}`}>
                  <path className="workflow-edge workflow-edge--hit" d={d} onClick={(e) => handleEdgePointerDown(e, edge.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedEdgeId(edge.id); const point = getLocalPoint(e); setContextMenu({ x: point.x, y: point.y, edgeId: edge.id }); }} />
                  <path className={`workflow-edge ${isSelected ? 'workflow-edge--selected' : ''} ${branchClass}`} d={d} />
                </g>
              );
            })}
            {connecting && (() => {
              const source = nodes.find((node) => node.id === connecting.sourceId);
              if (!source) return null;
              const start = getSourcePoint(source, connecting.sourceHandleId);
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
            const nodeRunStatus = workflowRunState?.nodeStates[node.id];
            const zIndex = isSelected ? 40 : isSnapTarget ? 35 : isHovered ? 30 : isOverlapping ? 20 : nodes.indexOf(node);

            return (
            <div
              key={node.id}
              className={`workflow-node workflow-node--${node.type} ${isSelected ? 'workflow-node--selected' : ''} ${isHovered ? 'workflow-node--hovered' : ''} ${isSelected && isHovered ? 'workflow-node--selected-hovered' : ''} ${isSnapTarget ? 'workflow-node--snap-target' : ''} ${isOverlapping ? 'workflow-node--overlap' : ''} ${!node.enabled ? 'workflow-node--disabled' : ''} ${nodeRunStatus ? `workflow-node--run-${nodeRunStatus}` : ''}`}
              style={{ left: node.position.x, top: node.position.y, width: node.width ?? NODE_WIDTH, height: node.height ?? NODE_HEIGHT, zIndex }}
              onMouseDown={(event) => handleNodePointerDown(event, node)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
                setContextMenu(getLocalPoint(event));
              }}
            >
              <div className="workflow-node__title">{node.title}</div>
              {node.type === 'recognize' ? (
                <div className={`workflow-node__strategies workflow-node__strategies--${node.data.executionMode}`}>
                  {(node.data.strategyOrder || ['coords', 'template', 'yolo', 'ocr', 'cloudApi'])
                    .filter((key: string) => (node.data.strategies as any)[key].enabled)
                    .map((key: string) => {
                      const labelMap: Record<string, string> = {
                        coords: '1',
                        template: '2',
                        yolo: '3',
                        ocr: '4',
                        cloudApi: '5',
                      };
                      return (
                        <span key={key} className="workflow-node__strategy-badge" title={key}>
                          {labelMap[key]}
                        </span>
                      );
                    })}
                </div>
              ) : (
                <div className="workflow-node__body">{getNodeSummary(node)}</div>
              )}
              {node.type === 'if' ? (
                <>
                  <button
                    className={`node-handle node-handle--source node-handle--if node-handle--if-true ${connecting?.snapTargetId === node.id ? 'node-handle--snap' : ''}`}
                    aria-label="连接输出（真）"
                    title="条件为真时走这条线"
                    onMouseDown={(event) => handleSourcePointerDown(event, node, 'true')}
                  />
                  <button
                    className={`node-handle node-handle--source node-handle--if node-handle--if-false ${connecting?.snapTargetId === node.id ? 'node-handle--snap' : ''}`}
                    aria-label="连接输出（假）"
                    title="条件为假时走这条线"
                    onMouseDown={(event) => handleSourcePointerDown(event, node, 'false')}
                  />
                </>
              ) : (
                <button
                  className={`node-handle node-handle--source ${connecting?.snapTargetId === node.id ? 'node-handle--snap' : ''}`}
                  aria-label="连接输出"
                  onMouseDown={(event) => handleSourcePointerDown(event, node)}
                />
              )}
              <span className={`node-handle node-handle--target ${isSnapTarget ? 'node-handle--snap' : ''}`} aria-hidden="true" />
            </div>
            );
          })}
        </div>

        {contextMenu && (
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
            {contextMenu.edgeId ? (
              <button
                onClick={() => {
                  setEdges((current) => current.filter((edge) => edge.id !== contextMenu.edgeId));
                  setSelectedEdgeId(null);
                  setContextMenu(null);
                }}
              >
                删除连线
              </button>
            ) : (
              <>
                <button onClick={copySelectedNode} disabled={!selectedNode}>复制节点</button>
                <button onClick={pasteNode} disabled={!clipboardNode && !selectedNode}>粘贴节点</button>
                <button onClick={deleteSelectedNode} disabled={!selectedNode}>删除节点</button>
              </>
            )}
          </div>
        )}
        {selectedNode && !dragging && (
          <div
            className="properties-panel-anchor"
            ref={panelAnchorRef}
            style={floatingPanelStyle ?? undefined}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <PropertiesPanel
              node={selectedNode}
              onChangeNode={updateNode}
              templateVersion={templateVersion}
              cloudApiVersion={cloudApiVersion}
              onOpenTemplateManager={() => setTemplateManagerOpen(true)}
              onOpenCloudApiManager={() => setCloudApiManagerOpen(true)}
              onOpenRecognizeTest={() => {
                if (!selectedNode || selectedNode.type !== 'recognize') return;
                setRecognizeTestPreset({
                  strategies: selectedNode.data.strategies,
                  strategyOrder: selectedNode.data.strategyOrder,
                });
                setRecognizeTestOpen(true);
              }}
              yoloVersion={yoloVersion}
              onOpenYoloManager={() => setYoloManagerOpen(true)}
            />
          </div>
        )}
        {debugPanelOpen && (
          <DebugPanel
            nodes={nodes}
            edges={edges}
            selectedNodeId={selectedNodeId}
            onFocusNode={(nodeId) => setSelectedNodeId(nodeId)}
            onClose={() => setDebugPanelOpen(false)}
            notice={workflowRunNotice}
            workflowState={workflowRunState}
            logs={workflowRunLogs}
          />
        )}
      </div>
      {globalEnvOpen && (
        <GlobalEnvModal
          onClose={() => setGlobalEnvOpen(false)}
          onChanged={() => setTemplateVersion((version) => version + 1)}
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
      {cloudApiManagerOpen && (
        <CloudApiManagerModal
          onClose={() => setCloudApiManagerOpen(false)}
          onChanged={() => setCloudApiVersion((version) => version + 1)}
        />
      )}
      {ocrTestOpen && (
        <OcrTestModal
          onClose={() => setOcrTestOpen(false)}
          initialText={ocrTestPreset?.text}
          initialEngine={ocrTestPreset?.engine}
        />
      )}
      {recognizeTestOpen && recognizeTestPreset && (
        <RecognizeTestModal
          onClose={() => setRecognizeTestOpen(false)}
          strategies={recognizeTestPreset.strategies}
          strategyOrder={recognizeTestPreset.strategyOrder}
          onApplyCoords={applyRecognizeCoords}
        />
      )}
      {streamManagerOpen && (
        <StreamManagerModal
          onClose={() => setStreamManagerOpen(false)}
          onChanged={() => setStreamVersion((version) => version + 1)}
        />
      )}
    </div>
  );
}

