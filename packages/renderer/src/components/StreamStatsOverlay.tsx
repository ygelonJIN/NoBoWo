import type { Ps5Frame } from '@nobowo/core';

type Props = {
  frame: Ps5Frame;
};

function latencyClass(latencyMs: number): string {
  if (latencyMs <= 80) return 'ok';
  if (latencyMs <= 160) return 'warn';
  return 'bad';
}

export function StreamStatsOverlay({ frame }: Props) {
  const trustedTelemetry = frame.telemetryVersion === 2;
  const fps = Number.isFinite(frame.fps) ? Math.max(0, frame.fps ?? 0) : 0;
  const displayLatencyMs = frame.timestamp > 0 ? Date.now() - frame.timestamp : Number.NaN;
  const latencyMs = Number.isFinite(displayLatencyMs)
    ? Math.max(0, Math.round(displayLatencyMs))
    : Math.max(0, Math.round(frame.latencyMs ?? 0));
  return (
    <div className="stream-stats-overlay" aria-label="串流画面状态">
      <span className="stream-stats-overlay__item">{frame.width || '?'}×{frame.height || '?'}</span>
      <span className="stream-stats-overlay__item">{trustedTelemetry ? `${fps.toFixed(fps >= 10 ? 0 : 1)} FPS` : 'FPS --'}</span>
      <span className={`stream-stats-overlay__item ${trustedTelemetry ? `stream-stats-overlay__latency stream-stats-overlay__latency--${latencyClass(latencyMs)}` : ''}`}>
        {trustedTelemetry ? `延迟${latencyMs}ms` : '延迟 --'}
      </span>
    </div>
  );
}
