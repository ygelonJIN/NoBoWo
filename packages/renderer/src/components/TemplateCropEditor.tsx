import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateRect } from '@nobowo/core';

type Point = { x: number; y: number };

type Props = {
  imageUrl: string;
  rect: TemplateRect | null;
  offset: ClickOffset;
  onRectChange: (rect: TemplateRect | null) => void;
  onOffsetChange: (offset: ClickOffset) => void;
};

const STAGE_MAX_H = 440;
const PREVIEW_MAX_W = 260;
const PREVIEW_MAX_H = 160;
const PREVIEW_MAX_SCALE = 3;
const MIN_CROP = 4;

export function TemplateCropEditor({ imageUrl, rect, offset, onRectChange, onOffsetChange }: Props) {
  const [natural, setNatural] = useState<Point | null>(null);
  const [availW, setAvailW] = useState(640);
  const [draft, setDraft] = useState<TemplateRect | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ start: Point; current: Point } | null>(null);
  const markerDragRef = useRef<boolean>(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ x: img.naturalWidth, y: img.naturalHeight });
    img.onerror = () => setNatural(null);
    img.src = imageUrl;
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

  const scale = natural ? Math.min(1, (availW - 24) / natural.x, STAGE_MAX_H / natural.y) : 1;
  const displayW = natural ? Math.max(1, Math.round(natural.x * scale)) : 0;
  const displayH = natural ? Math.max(1, Math.round(natural.y * scale)) : 0;

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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural) return;
      e.preventDefault();
      surfaceRef.current?.setPointerCapture(e.pointerId);
      const p = toImagePoint(e.clientX, e.clientY);
      dragRef.current = { start: p, current: p };
      setDraft(null);
    },
    [natural, toImagePoint],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !natural) return;
      const p = toImagePoint(e.clientX, e.clientY);
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
    },
    [clampRect, natural, toImagePoint],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !natural) return;
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
      setDraft(null);
    },
    [clampRect, natural, onRectChange, rect],
  );

  const selection = draft ?? rect;
  const selLeft = selection ? selection.x * scale : 0;
  const selTop = selection ? selection.y * scale : 0;
  const selWidth = selection ? selection.width * scale : 0;
  const selHeight = selection ? selection.height * scale : 0;

  const pvScale = rect ? Math.min(PREVIEW_MAX_SCALE, PREVIEW_MAX_W / rect.width, PREVIEW_MAX_H / rect.height) : 1;
  const pvW = rect ? Math.max(1, Math.round(rect.width * pvScale)) : 0;
  const pvH = rect ? Math.max(1, Math.round(rect.height * pvScale)) : 0;
  const halfW = rect ? Math.round(rect.width / 2) : 0;
  const halfH = rect ? Math.round(rect.height / 2) : 0;
  const markerX = rect ? Math.max(0, Math.min(pvW, (halfW + offset.x) * pvScale)) : 0;
  const markerY = rect ? Math.max(0, Math.min(pvH, (halfH + offset.y) * pvScale)) : 0;

  const handleMarkerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    previewRef.current?.setPointerCapture(e.pointerId);
    markerDragRef.current = true;
  }, []);

  const handleMarkerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!markerDragRef.current || !rect || !previewRef.current) return;
      const bounds = previewRef.current.getBoundingClientRect();
      const px = (e.clientX - bounds.left) / pvScale;
      const py = (e.clientY - bounds.top) / pvScale;
      const nx = Math.max(-halfW, Math.min(halfW, Math.round(px) - halfW));
      const ny = Math.max(-halfH, Math.min(halfH, Math.round(py) - halfH));
      onOffsetChange({ x: nx, y: ny });
    },
    [halfH, halfW, onOffsetChange, pvScale, rect],
  );

  const handleMarkerUp = useCallback(() => {
    markerDragRef.current = false;
  }, []);

  return (
    <div className="crop-editor">
      <p className="crop-editor__hint">
        {rect ? '在图片上重新拖拽可调整选区' : '在图片上拖拽，框选要识别的区域'}
      </p>
      <div className="crop-editor__stage" ref={stageRef}>
        {natural ? (
          <div
            className="crop-editor__surface"
            ref={surfaceRef}
            style={{ width: displayW, height: displayH }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <img src={imageUrl} style={{ width: displayW, height: displayH }} alt="" draggable={false} />
            {selection && (
              <>
                <div
                  className="crop-editor__selection"
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
          </div>
        ) : (
          <div className="crop-editor__loading">图片加载中…</div>
        )}
      </div>

      {rect && rect.width >= MIN_CROP && rect.height >= MIN_CROP && (
        <div className="crop-editor__preview-row">
        <div className="crop-editor__preview">
          <div className="crop-editor__preview-head">
            <span>模板预览</span>
            <button className="crop-editor__reset" onClick={() => onOffsetChange({ x: 0, y: 0 })}>
              重置中心
            </button>
          </div>
          <div
            className="crop-editor__preview-box"
            ref={previewRef}
            style={{ width: pvW, height: pvH }}
            onPointerDown={handleMarkerDown}
            onPointerMove={handleMarkerMove}
            onPointerUp={handleMarkerUp}
          >
            {natural && (
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                style={{
                  display: 'block',
                  width: natural.x * pvScale,
                  height: natural.y * pvScale,
                  transform: `translate(${-rect.x * pvScale}px, ${-rect.y * pvScale}px)`,
                }}
              />
            )}
            <div
              className="crop-editor__marker"
              style={{ left: markerX, top: markerY }}
              title={`点击位置偏移：X ${offset.x}，Y ${offset.y}`}
            />
          </div>
          <div className="crop-editor__offset-readout">
            偏移 X {offset.x} / Y {offset.y}（0, 0 = 匹配区域中心）
          </div>
        </div>
        <div className="crop-editor__hint-side">
          <span style={{ fontSize: '24px' }}>↓</span>
          <span>填写信息</span>
        </div>
        </div>
      )}
    </div>
  );
}