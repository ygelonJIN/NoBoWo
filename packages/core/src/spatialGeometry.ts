import type { Point2D, SpatialTargetEdge } from './index';

/** 返回点到矩形边缘的最近点；点在矩形内部时投影到最近边。 */
export function closestPointOnBox(point: Point2D, box: [number, number, number, number]): Point2D {
  const [x, y, width, height] = box;
  const left = x;
  const top = y;
  const right = x + width;
  const bottom = y + height;
  const inside = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
  if (!inside) {
    return {
      x: Math.max(left, Math.min(right, point.x)),
      y: Math.max(top, Math.min(bottom, point.y)),
    };
  }
  const candidates: Point2D[] = [
    { x: left, y: point.y },
    { x: right, y: point.y },
    { x: point.x, y: top },
    { x: point.x, y: bottom },
  ];
  return candidates.reduce((best, candidate) => {
    const bestDistance = (best.x - point.x) ** 2 + (best.y - point.y) ** 2;
    const candidateDistance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    return candidateDistance < bestDistance ? candidate : best;
  }, candidates[0]);
}

/** 计算两个矩形框边界之间的最短距离；可只计算目标框指定边。 */
export function closestPointsBetweenBoxes(
  playerBox: [number, number, number, number],
  targetBox: [number, number, number, number],
  targetEdge: SpatialTargetEdge = 'nearest',
): { player: Point2D; target: Point2D; distance: number } {
  const [px, py, pw, ph] = playerBox;
  const [tx, ty, tw, th] = targetBox;
  const playerCenter = { x: px + pw / 2, y: py + ph / 2 };
  const targetCenter = { x: tx + tw / 2, y: ty + th / 2 };
  const playerRight = px + pw;
  const playerBottom = py + ph;
  const targetRight = tx + tw;
  const targetBottom = ty + th;
  const overlapX = px <= targetRight && playerRight >= tx;
  const overlapY = py <= targetBottom && playerBottom >= ty;

  if (targetEdge !== 'nearest') {
    const targetEdges: Record<Exclude<SpatialTargetEdge, 'nearest'>, [Point2D, Point2D]> = {
      top: [{ x: tx, y: ty }, { x: targetRight, y: ty }],
      bottom: [{ x: tx, y: targetBottom }, { x: targetRight, y: targetBottom }],
      left: [{ x: tx, y: ty }, { x: tx, y: targetBottom }],
      right: [{ x: targetRight, y: ty }, { x: targetRight, y: targetBottom }],
    };
    const [start, end] = targetEdges[targetEdge];
    const projection = targetEdge === 'top' || targetEdge === 'bottom'
      ? { x: Math.max(start.x, Math.min(end.x, playerCenter.x)), y: start.y }
      : { x: start.x, y: Math.max(start.y, Math.min(end.y, playerCenter.y)) };
    const candidates = [start, end, projection];
    let bestPlayer = closestPointOnBox(candidates[0], playerBox);
    let bestTarget = candidates[0];
    let bestDistance = Math.hypot(bestTarget.x - bestPlayer.x, bestTarget.y - bestPlayer.y);
    for (const targetPoint of candidates.slice(1)) {
      const playerPoint = closestPointOnBox(targetPoint, playerBox);
      const distance = Math.hypot(targetPoint.x - playerPoint.x, targetPoint.y - playerPoint.y);
      if (distance < bestDistance) {
        bestPlayer = playerPoint;
        bestTarget = targetPoint;
        bestDistance = distance;
      }
    }
    return { player: bestPlayer, target: bestTarget, distance: bestDistance };
  }

  if (overlapX && overlapY) {
    return { player: playerCenter, target: targetCenter, distance: 0 };
  }

  let playerPoint: Point2D;
  let targetPoint: Point2D;
  if (overlapX) {
    const overlapLeft = Math.max(px, tx);
    const overlapRight = Math.min(playerRight, targetRight);
    const x = Math.max(overlapLeft, Math.min(overlapRight, playerCenter.x));
    if (playerCenter.y < targetCenter.y) {
      playerPoint = { x, y: playerBottom };
      targetPoint = { x, y: ty };
    } else {
      playerPoint = { x, y: py };
      targetPoint = { x, y: targetBottom };
    }
  } else if (overlapY) {
    const overlapTop = Math.max(py, ty);
    const overlapBottom = Math.min(playerBottom, targetBottom);
    const y = Math.max(overlapTop, Math.min(overlapBottom, playerCenter.y));
    if (playerCenter.x < targetCenter.x) {
      playerPoint = { x: playerRight, y };
      targetPoint = { x: tx, y };
    } else {
      playerPoint = { x: px, y };
      targetPoint = { x: targetRight, y };
    }
  } else {
    playerPoint = {
      x: playerCenter.x < targetCenter.x ? playerRight : px,
      y: playerCenter.y < targetCenter.y ? playerBottom : py,
    };
    targetPoint = {
      x: playerCenter.x < targetCenter.x ? tx : targetRight,
      y: playerCenter.y < targetCenter.y ? ty : targetBottom,
    };
  }
  return {
    player: playerPoint,
    target: targetPoint,
    distance: Math.hypot(targetPoint.x - playerPoint.x, targetPoint.y - playerPoint.y),
  };
}

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
