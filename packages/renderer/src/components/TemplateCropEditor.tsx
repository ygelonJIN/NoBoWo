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
  | null;

const STAGE_MAX_H = 440;
const MIN_CROP = 4;

export function TemplateCropEditor({ imageUrl, rect, offset, tool, onRectChange, onOffsetChange }: Props) {
  const [natural, setNatural] = useState<Point | null>(null);
  const [availW, setAvailW] = useState(640);
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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !natural) return;
      e.preventDefault();
      surfaceRef.current?.setPointerCapture(e.pointerId);
      const p = toImagePoint(e.clientX, e.clientY);
      setDraft(null);
      if (tool === 'draw') {
        dragRef.current = { kind: 'draw', start: p, current: p };
        return;
      }
      if (rect && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height) {
        dragRef.current = { kind: 'move', start: p, orig: rect };
      }
    },
    [natural, rect, toImagePoint, tool],
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
      }
    },
    [clampRect, moveRect, natural, onRectChange, resizeRect, toImagePoint],
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

  const hint =
    tool === 'draw'
      ? rect
        ? '在图片上拖拽，重新框选要识别的区域'
        : '在图片上拖拽，框选要识别的区域'
      : rect
        ? '拖拽选框可移动，拖动四角可调整大小'
        : '当前没有选框，请切换到「框选」模式绘制';

  return (
    <div className={`crop-editor crop-editor--${tool}`}>
      <p className="crop-editor__hint">{hint}</p>
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
          </div>
        ) : (
          <div className="crop-editor__loading">图片加载中…</div>
        )}
      </div>
    </div>
  );
}
