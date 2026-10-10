import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateRect } from '@nobowo/core';

type Point = { x: number; y: number };

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
  | { kind: 'offset'; start: Point; orig: ClickOffset; rect: TemplateRect }
  | { kind: 'pan'; start: Point; grab: Point }
  | null;

const MIN_CROP = 4;
const ZOOM_STEP = 1.15;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 64;

export function TemplateCropEditor({ imageUrl, rect, offset, tool, onRectChange, onOffsetChange }: Props) {
  const [natural, setNatural] = useState<Point | null>(null);
  const [availW, setAvailW] = useState(640);
  const [availH, setAvailH] = useState(480);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [draft, setDraft] = useState<TemplateRect | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ x: img.naturalWidth, y: img.naturalHeight });
    img.onerror = () => setNatural(null);
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [imageUrl]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateSize = () => {
      setAvailW(Math.floor(el.clientWidth));
      setAvailH(Math.floor(el.clientHeight));
    };
    updateSize();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setAvailW(Math.floor(entry.contentRect.width));
        setAvailH(Math.floor(entry.contentRect.height));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = natural
    ? Math.min(2, Math.max(0.01, Math.min((availW - 24) / natural.x, (availH - 24) / natural.y)))
    : 1;
  const scale = fitScale * zoom;
  const maxZoom = natural ? Math.max(8, Math.min(MAX_ZOOM, 8 / fitScale)) : 8;
  const displayW = natural ? Math.max(1, Math.round(natural.x * scale)) : 0;
  const displayH = natural ? Math.max(1, Math.round(natural.y * scale)) : 0;

  const centerStage = useCallback(() => setPan({ x: 0, y: 0 }), []);

  useEffect(() => {
    const frame = requestAnimationFrame(centerStage);
    return () => cancelAnimationFrame(frame);
  }, [centerStage, imageUrl, natural]);

  useEffect(() => {
    const stage = stageRef.current;
    const surface = surfaceRef.current;
    if (!stage || !surface || !natural) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const nextZoom = Math.min(maxZoom, Math.max(MIN_ZOOM, zoom * factor));
      if (nextZoom === zoom) return;
      const surfaceBounds = surface.getBoundingClientRect();
      const stageBounds = stage.getBoundingClientRect();
      const oldScale = fitScale * zoom;
      const newScale = fitScale * nextZoom;
      const imagePoint = {
        x: (e.clientX - surfaceBounds.left) / oldScale,
        y: (e.clientY - surfaceBounds.top) / oldScale,
      };
      const viewportCenter = {
        x: stageBounds.left + stageBounds.width / 2,
        y: stageBounds.top + stageBounds.height / 2,
      };
      setPan({
        x: e.clientX - (imagePoint.x - natural.x / 2) * newScale - viewportCenter.x,
        y: e.clientY - (imagePoint.y - natural.y / 2) * newScale - viewportCenter.y,
      });
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

  const handleOffsetHandleDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural || !rect) return;
      e.stopPropagation();
      e.preventDefault();
      const p = toImagePoint(e.clientX, e.clientY);
      dragRef.current = { kind: 'offset', start: p, orig: { ...offset }, rect: { ...rect } };
    },
    [natural, offset, rect, toImagePoint],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural) return;
      e.preventDefault();
      const p = toImagePoint(e.clientX, e.clientY);
      setDraft(null);

      if (tool === 'draw') {
        dragRef.current = { kind: 'draw', start: p, current: p };
        return;
      }
      dragRef.current = {
        kind: 'pan',
        start: { x: e.clientX, y: e.clientY },
        grab: { ...pan },
      };
    },
    [natural, pan, toImagePoint, tool],
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
        setPan({
          x: drag.grab.x + e.clientX - drag.start.x,
          y: drag.grab.y + e.clientY - drag.start.y,
        });
      }
    },
    [clampRect, natural, onOffsetChange, toImagePoint],
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
        ? '拖拽可重画选框 · 滚轮或按钮缩放'
        : '在图片上拖拽框选目标区域 · 滚轮或按钮缩放'
      : '拖动任意位置自由移动画布 · 红点设置点击位置 · 滚轮或按钮缩放';

  const offDesc = [
    offset.x > 0 ? `右 ${offset.x}` : offset.x < 0 ? `左 ${Math.abs(offset.x)}` : '',
    offset.y > 0 ? `下 ${offset.y}` : offset.y < 0 ? `上 ${Math.abs(offset.y)}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={`crop-editor crop-editor--${tool}`}>
      <div className="crop-editor__bar">
        <span className="crop-editor__bar-hint">{hint}</span>
        <div className="crop-editor__bar-right">
          <button
            className="crop-editor__zoom-reset"
            onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current / ZOOM_STEP))}
            disabled={zoom <= MIN_ZOOM}
            title="缩小"
            aria-label="缩小"
          >
            −
          </button>
          <span className="crop-editor__zoom-label">{Math.round(scale * 100)}%</span>
          <button
            className="crop-editor__zoom-reset"
            onClick={() => setZoom((current) => Math.min(maxZoom, current * ZOOM_STEP))}
            disabled={zoom >= maxZoom}
            title="放大"
            aria-label="放大"
          >
            +
          </button>
          <button className="crop-editor__zoom-reset" onClick={() => { setZoom(1); centerStage(); }} disabled={zoom === 1}>
            适配窗口
          </button>
        </div>
      </div>
      <div
        className="crop-editor__stage"
        ref={stageRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {natural ? (
          <div className="crop-editor__viewport">
            <div
              className="crop-editor__surface"
              ref={surfaceRef}
              style={{
                width: displayW,
                height: displayH,
                left: `calc(50% + ${pan.x}px)`,
                top: `calc(50% + ${pan.y}px)`,
              }}
              onPointerDown={handlePointerDown}
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
          </div>
        ) : (
          <div className="crop-editor__loading">图片加载中…</div>
        )}
      </div>

      <div
        className={`crop-editor__status ${rect && !draft ? '' : 'crop-editor__status--hidden'}`}
        aria-hidden={!rect || Boolean(draft)}
      >
        {rect && (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
