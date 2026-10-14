import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VisionOverlayMarker, VisionOverlayPayload } from '@nobowo/core';

type StoredOverlay = {
  key: string;
  payload: VisionOverlayPayload;
  expiresAt: number;
};

type PublishOptions = {
  ttlMs?: number;
};

const EMPTY_OVERLAYS: StoredOverlay[] = [];
const DEFAULT_TTL_MS = 1500;
let overlays: StoredOverlay[] = EMPTY_OVERLAYS;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

function pruneExpired() {
  const now = Date.now();
  const next = overlays.filter((item) => item.expiresAt > now);
  if (next.length !== overlays.length) {
    overlays = next.length > 0 ? next : EMPTY_OVERLAYS;
    emitChange();
  }
}

export function publishVisionOverlay(
  key: string,
  payload: VisionOverlayPayload,
  options?: PublishOptions,
) {
  pruneExpired();
  const ttlMs = Math.max(250, options?.ttlMs ?? DEFAULT_TTL_MS);
  const next: StoredOverlay = { key, payload, expiresAt: Date.now() + ttlMs };
  const index = overlays.findIndex((item) => item.key === key);
  overlays = index >= 0
    ? overlays.map((item) => (item.key === key ? next : item))
    : [...overlays, next];
  emitChange();
}

export function clearVisionOverlay(prefix?: string) {
  pruneExpired();
  const next = prefix
    ? overlays.filter((item) => !item.key.startsWith(prefix))
    : EMPTY_OVERLAYS;
  if (next.length !== overlays.length) {
    overlays = next.length > 0 ? next : EMPTY_OVERLAYS;
    emitChange();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return overlays;
}

function useVisionOverlays() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type Props = {
  frameWidth: number;
  frameHeight: number;
  className?: string;
};

type ViewportSize = { width: number; height: number };

function formatLabel(marker: VisionOverlayMarker) {
  const confidence = typeof marker.confidence === 'number' ? ` ${Math.round(marker.confidence)}%` : '';
  return `${marker.label ?? (marker.kind === 'box' ? '检测' : '位置')}${confidence}`;
}

export function StreamVisionOverlay({ frameWidth, frameHeight, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });
  const storedOverlays = useVisionOverlays();

  useEffect(() => {
    if (storedOverlays.length === 0) return;
    const nextExpiry = Math.min(...storedOverlays.map((item) => item.expiresAt));
    const timer = window.setTimeout(pruneExpired, Math.max(250, nextExpiry - Date.now() + 30));
    return () => window.clearTimeout(timer);
  }, [storedOverlays]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setViewport({ width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const content = useMemo(() => {
    if (frameWidth <= 0 || frameHeight <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
    const scale = Math.min(viewport.width / frameWidth, viewport.height / frameHeight);
    return {
      left: (viewport.width - frameWidth * scale) / 2,
      top: (viewport.height - frameHeight * scale) / 2,
      width: frameWidth * scale,
      height: frameHeight * scale,
    };
  }, [frameHeight, frameWidth, viewport.height, viewport.width]);

  const markers = useMemo(() => {
    if (!content) return [];
    return storedOverlays
      .filter((item) => item.payload.sourceKind === 'ps5Direct' || item.key.startsWith('workflow:'))
      .flatMap((item) => {
        const sourceWidth = Math.max(1, item.payload.sourceWidth);
        const sourceHeight = Math.max(1, item.payload.sourceHeight);
        const scaleX = frameWidth / sourceWidth;
        const scaleY = frameHeight / sourceHeight;
        return item.payload.markers.map((marker) => {
          const x = content.left + marker.x * scaleX * (content.width / frameWidth);
          const y = content.top + marker.y * scaleY * (content.height / frameHeight);
          if (marker.kind === 'point') {
            return { marker, x, y, width: 0, height: 0 };
          }
          return {
            marker,
            x,
            y,
            width: marker.width * scaleX * (content.width / frameWidth),
            height: marker.height * scaleY * (content.height / frameHeight),
          };
        });
      });
  }, [content, frameHeight, frameWidth, storedOverlays]);

  return (
    <div
      ref={containerRef}
      className={['stream-vision-overlay', className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      {content && markers.map(({ marker, x, y, width, height }, index) => {
        const color = marker.color ?? '#50e6ff';
        const label = formatLabel(marker);
        return marker.kind === 'box' ? (
          <div
            className="stream-vision-overlay__box"
            key={`${index}-${marker.label ?? ''}-${Math.round(x)}-${Math.round(y)}`}
            style={{ left: x, top: y, width, height, borderColor: color, color }}
          >
            <span className="stream-vision-overlay__label" style={{ backgroundColor: color }}>{label}</span>
          </div>
        ) : (
          <div
            className="stream-vision-overlay__point"
            key={`${index}-${marker.label ?? ''}-${Math.round(x)}-${Math.round(y)}`}
            style={{ left: x, top: y, color }}
          >
            <span className="stream-vision-overlay__crosshair" />
            <span className="stream-vision-overlay__label" style={{ backgroundColor: color }}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
