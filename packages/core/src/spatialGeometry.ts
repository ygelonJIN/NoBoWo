import type { Point2D } from './index';

/**
 * 计算点到折线的最近点。折线至少包含两个点，用于表达三分弧线、边界或目标带中线。
 */
export function closestPointOnPolyline(point: Point2D, polyline: Point2D[]): Point2D {
  if (polyline.length === 0) return { ...point };
  if (polyline.length === 1) return { ...polyline[0] };
  let best = { ...polyline[0] };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    const start = polyline[index - 1];
    const end = polyline[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 1e-12
      ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
      : 0;
    const candidate = { x: start.x + t * dx, y: start.y + t * dy };
    const distanceSquared = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (distanceSquared < bestDistance) {
      best = candidate;
      bestDistance = distanceSquared;
    }
  }
  return best;
}

function normalizeVector(vector: Point2D): Point2D {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

/** 根据距离计算接近目标时的连续移动向量。 */
export function calculateSpatialMovement(
  distance: number,
  direction: Point2D,
  options: { minMagnitude?: number; maxMagnitude?: number; deadZone?: number; brakeDistance?: number } = {},
): { vector: Point2D; magnitude: number } {
  const minMagnitude = Math.max(0, Math.min(1, options.minMagnitude ?? 0.2));
  const maxMagnitude = Math.max(minMagnitude, Math.min(1, options.maxMagnitude ?? 0.7));
  const deadZone = Math.max(0, options.deadZone ?? 0);
  const brakeDistance = Math.max(deadZone + 1e-6, options.brakeDistance ?? 120);
  const normalized = normalizeVector(direction);
  if (distance <= deadZone || Math.hypot(normalized.x, normalized.y) < 1e-9) {
    return { vector: { x: 0, y: 0 }, magnitude: 0 };
  }
  const ratio = Math.max(0, Math.min(1, (distance - deadZone) / (brakeDistance - deadZone)));
  const magnitude = minMagnitude + (maxMagnitude - minMagnitude) * ratio;
  return { vector: { x: normalized.x * magnitude, y: normalized.y * magnitude }, magnitude };
}
