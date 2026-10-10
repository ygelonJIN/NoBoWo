import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateRect } from '@nobowo/core';

type Point = { x: number; y: number };

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type Props = {
  imageUrl: string;
  rect: TemplateRect | null;
  offset: ClickOffset;
  tool: 'draw' | 'move';
  onRectChange: (rect: TemplateRect | null) => void;
  onOffsetChange: (offset: ClickOffset) => void;
};

type DragState =
  | { kind: 'draw'; start: Point; current: Point }
  | { kind: 'move'; start: Point; orig: TemplateRect }
  | { kind: 'resize'; corner: Corner; start: Point; orig: TemplateRect }
  | { kind: 'offset'; start: Point; orig: ClickOffset; rect: TemplateRect }
  | { kind: 'pan'; start: Point; grab: Point }
  | null;

const STAGE_MAX_H = 600;
const MIN_CROP = 4;
const OFFSET_HIT_PX = 14;
const ZOOM_STEP = 1.15;
const MAX_ZOOM = 24;

export function TemplateCropEditor({ imageUrl, rect, offset, tool, onRectChange, onOffsetChange }: Props) {
  const [natural, setNatural] = useState<Point | null>(null);
  const [availW, setAvailW] = useState(640);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [draft, setDraft] = useState<TemplateRect | null>(null);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ x: img.naturalWidth, y: img.naturalHeight });
    img.onerror = () => setNatural(null);
    img.src = imageUrl;
  }, [imageUrl]);

  // 切换图片时重置缩放；居中由 surface 的 margin auto 负责
  useEffect(() => {
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    setPan({ x: 0, y: 0 });
  }, [imageUrl]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setAvailW(Math.floor(entry.contentRect.width));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = natural ? Math.min(2, Math.max(0.5, Math.min((availW - 24) / natural.x, STAGE_MAX_H / natural.y))) : 1;
  const scale = fitScale * zoom;
  const maxZoom = natural ? Math.max(4, Math.min(MAX_ZOOM, (1 / fitScale) * 2)) : 4;
  const displayW = natural ? Math.max(1, Math.round(natural.x * scale)) : 0;
  const displayH = natural ? Math.max(1, Math.round(natural.y * scale)) : 0;

  // 滚轮缩放：以光标为中心
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !natural) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const nextZoom = Math.min(maxZoom, Math.max(1, zoom * factor));
      if (nextZoom === zoom) return;
      const rect = stage.getBoundingClientRect();
      const oldScale = fitScale * zoom;
      const newScale = fitScale * nextZoom;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const nextPan = {
        x: mouseX - (mouseX - panRef.current.x) * (newScale / oldScale),
        y: mouseY - (mouseY - panRef.current.y) * (newScale / oldScale),
      };
      panRef.current = nextPan;
      setPan(nextPan);
      setZoom(nextZoom);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [fitScale, maxZoom, natural, zoom]);

  const clampRect = useCallback((r: TemplateRect, n: Point): TemplateRect => {
    const x = Math.max(0, Math.min(n.x, r.x));
    const y = Math.max(0, Math.min(n.y, r.y));
    const width = Math.min(n.x - x, r.width);
    const height = Math.min(n.y - y, r.height);
    return { x, y, width, height };
  }, []);

  const toImagePoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const el = surfaceRef.current;
      if (!el) return { x: 0, y: 0 };
      const bounds = el.getBoundingClientRect();
      return { x: (clientX - bounds.left) / scale, y: (clientY - bounds.top) / scale };
    },
    [scale],
  );

  const moveRect = useCallback(
    (orig: TemplateRect, dx: number, dy: number, n: Point): TemplateRect => ({
      x: Math.max(0, Math.min(n.x - orig.width, orig.x + dx)),
      y: Math.max(0, Math.min(n.y - orig.height, orig.y + dy)),
      width: orig.width,
      height: orig.height,
    }),
    [],
  );

  const resizeRect = useCallback((orig: TemplateRect, corner: Corner, p: Point, n: Point): TemplateRect => {
    const min = MIN_CROP;
    switch (corner) {
      case 'nw': {
        const x = Math.min(orig.x + orig.width - min, Math.max(0, p.x));
        const y = Math.min(orig.y + orig.height - min, Math.max(0, p.y));
        return { x, y, width: orig.x + orig.width - x, height: orig.y + orig.height - y };
      }
      case 'ne': {
        const y = Math.min(orig.y + orig.height - min, Math.max(0, p.y));
        return {
          x: orig.x,
          y,
          width: Math.max(min, Math.min(n.x - orig.x, p.x - orig.x)),
          height: orig.y + orig.height - y,
        };
      }
      case 'sw': {
        const x = Math.min(orig.x + orig.width - min, Math.max(0, p.x));
        return {
          x,
          y: orig.y,
          width: orig.x + orig.width - x,
          height: Math.max(min, Math.min(n.y - orig.y, p.y - orig.y)),
        };
      }
      case 'se': {
        return {
          x: orig.x,
          y: orig.y,
          width: Math.max(min, Math.min(n.x - orig.x, p.x - orig.x)),
          height: Math.max(min, Math.min(n.y - orig.y, p.y - orig.y)),
        };
      }
    }
  }, []);

  const handleOffsetHandleDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural || !rect) return;
      e.stopPropagation();
      e.preventDefault();
      surfaceRef.current?.setPointerCapture(e.pointerId);
      const p = toImagePoint(e.clientX, e.clientY);
      dragRef.current = { kind: 'offset', start: p, orig: { ...offset }, rect: { ...rect } };
    },
    [natural, offset, rect, toImagePoint],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural) return;
      e.preventDefault();
      surfaceRef.current?.setPointerCapture(e.pointerId);
      const p = toImagePoint(e.clientX, e.clientY);
      setDraft(null);

      if (rect && !draft) {
        const cx = rect.x + rect.width / 2 + offset.x;
        const cy = rect.y + rect.height / 2 + offset.y;
        const dist = Math.hypot((p.x - cx) * scale, (p.y - cy) * scale);
        if (dist < OFFSET_HIT_PX) {
          dragRef.current = { kind: 'offset', start: p, orig: { ...offset }, rect: { ...rect } };
          return;
        }
      }

      if (tool === 'draw') {
        dragRef.current = { kind: 'draw', start: p, current: p };
        return;
      }
      if (rect && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) {
        dragRef.current = { kind: 'move', start: p, orig: rect };
        return;
      }
      // 放大后拖拽图片本身或空白区域时平移画布
      if (zoom > 1) {
        dragRef.current = {
          kind: 'pan',
          start: { x: e.clientX, y: e.clientY },
          grab: { x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y },
        };
      }
    },
    [draft, natural, offset, rect, scale, toImagePoint, tool, zoom, pan],
  );

  const handleResizeDown = useCallback(
    (e: React.PointerEvent, corner: Corner) => {
      if (e.button !== 0 || !natural || !rect) return;
      e.stopPropagation();
      e.preventDefault();
      surfaceRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = { kind: 'resize', corner, start: toImagePoint(e.clientX, e.clientY), orig: rect };
    },
    [natural, rect, toImagePoint],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !natural) return;
      const p = toImagePoint(e.clientX, e.clientY);
      if (drag.kind === 'draw') {
        drag.current = p;
        setDraft(
          clampRect(
            {
              x: Math.min(drag.start.x, p.x),
              y: Math.min(drag.start.y, p.y),
              width: Math.abs(p.x - drag.start.x),
              height: Math.abs(p.y - drag.start.y),
            },
            natural,
          ),
        );
      } else if (drag.kind === 'move') {
        onRectChange(moveRect(drag.orig, p.x - drag.start.x, p.y - drag.start.y, natural));
      } else if (drag.kind === 'resize') {
        onRectChange(resizeRect(drag.orig, drag.corner, p, natural));
      } else if (drag.kind === 'offset') {
        const dx = p.x - drag.start.x;
        const dy = p.y - drag.start.y;
        const boundX = drag.rect.width / 2;
        const boundY = drag.rect.height / 2;
        onOffsetChange({
          x: Math.max(-boundX, Math.min(boundX, Math.round(drag.orig.x + dx))),
          y: Math.max(-boundY, Math.min(boundY, Math.round(drag.orig.y + dy))),
        });
      } else if (drag.kind === 'pan') {
        const nextPan = {
          x: e.clientX - drag.grab.x,
          y: e.clientY - drag.grab.y,
        };
        panRef.current = nextPan;
        setPan(nextPan);
      }
    },
    [clampRect, moveRect, natural, onOffsetChange, onRectChange, resizeRect, toImagePoint],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !natural) return;
      if (drag.kind === 'draw') {
        const r = clampRect(
          {
            x: Math.min(drag.start.x, drag.current.x),
            y: Math.min(drag.start.y, drag.current.y),
            width: Math.abs(drag.current.x - drag.start.x),
            height: Math.abs(drag.current.y - drag.start.y),
          },
          natural,
        );
        if (r.width >= MIN_CROP && r.height >= MIN_CROP) {
          onRectChange(r);
        } else if (!rect) {
          onRectChange(null);
        }
      }
      setDraft(null);
    },
    [clampRect, natural, onRectChange, rect],
  );

  const selection = draft ?? rect;
  const selLeft = selection ? selection.x * scale : 0;
  const selTop = selection ? selection.y * scale : 0;
  const selWidth = selection ? selection.width * scale : 0;
  const selHeight = selection ? selection.height * scale : 0;

  const clickLeft = rect ? (rect.x + rect.width / 2 + offset.x) * scale : 0;
  const clickTop = rect ? (rect.y + rect.height / 2 + offset.y) * scale : 0;
  const isOffsetCenter = offset.x === 0 && offset.y === 0;

  const hint =
    tool === 'draw'
      ? rect
        ? '拖拽可重画选框 · 滚轮缩放'
        : '在图片上拖拽，框选要识别的区域 · 滚轮缩放'
      : rect
        ? '拖拽选框可移动 · 四角调整大小 · 红点设置点击位置 · 滚轮缩放，放大后拖空白处平移'
        : '当前没有选框，请切换到「框选」模式绘制 · 滚轮缩放';

  const offDesc = [
    offset.x > 0 ? `右 ${offset.x}` : offset.x < 0 ? `左 ${Math.abs(offset.x)}` : '',
    offset.y > 0 ? `下 ${offset.y}` : offset.y < 0 ? `上 ${Math.abs(offset.y)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={`crop-editor crop-editor--${tool}`}>
      <div className="crop-editor__bar">
        <span className="crop-editor__bar-hint">{hint}</span>
        <div className="crop-editor__bar-right">
          <span className="crop-editor__zoom-label">{Math.round(scale * 100)}%</span>
          <button className="crop-editor__zoom-reset" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} disabled={zoom <= 1}>
            适配窗口
          </button>
        </div>
      </div>
      <div className="crop-editor__stage" ref={stageRef}>
        {natural ? (
          <div
            className="crop-editor__surface"
            ref={surfaceRef}
            style={{ width: displayW, height: displayH, transform: `translate(${pan.x}px, ${pan.y}px)` }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <img src={imageUrl} style={{ width: displayW, height: displayH }} alt="" draggable={false} />
            {selection && (
              <>
                <div
                  className={`crop-editor__selection ${draft ? 'crop-editor__selection--draft' : ''}`}
                  style={{ left: selLeft, top: selTop, width: selWidth, height: selHeight }}
                />
                <div
                  className="crop-editor__size-label"
                  style={{ left: selLeft, top: selTop }}
                >
                  {Math.round(selection.width)} × {Math.round(selection.height)}
                </div>
                {tool === 'move' && !draft && (
                  <>
                    {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => (
                      <span
                        key={corner}
                        className={`crop-editor__handle crop-editor__handle--${corner}`}
                        onPointerDown={(e) => handleResizeDown(e, corner)}
                      />
                    ))}
                  </>
                )}
              </>
            )}
            {rect && !draft && (
              <div
                className="crop-editor__click-point"
                style={{ left: clickLeft, top: clickTop }}
                onPointerDown={handleOffsetHandleDown}
                title={`点击偏移 ${offset.x}, ${offset.y} — 拖动调整`}
                role="button"
                aria-label={`点击点 ${offset.x}, ${offset.y}`}
              >
                <span className="crop-editor__click-point-inner" />
                {isOffsetCenter && <span className="crop-editor__click-point-badge">中心</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="crop-editor__loading">图片加载中…</div>
        )}
      </div>

      {rect && !draft && (
        <div className="crop-editor__status">
          <span className="crop-editor__status-item">
            <span className="crop-editor__status-label">选框</span>
            <span className="crop-editor__status-value">{Math.round(rect.width)} × {Math.round(rect.height)}</span>
          </span>
          <span className="crop-editor__status-sep" aria-hidden="true" />
          <span className="crop-editor__status-item">
            <span className="crop-editor__status-label">点击点</span>
            <span className="crop-editor__status-value">({offset.x}, {offset.y})</span>
            {!isOffsetCenter && offDesc && <span className="crop-editor__status-sub">距中心 {offDesc}</span>}
          </span>
          <span className="crop-editor__status-tip">拖动红色点调整点击位置</span>
          <button className="crop-editor__offset-reset" onClick={() => onOffsetChange({ x: 0, y: 0 })} disabled={isOffsetCenter}>
            回中心
          </button>
        </div>
      )}
    </div>
  );
}
