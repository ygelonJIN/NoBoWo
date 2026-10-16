import type { MoveDirection, Point2D } from './index';

/** 持续移动闭环固定按用户约定的每秒30帧执行。 */
export const CONTINUOUS_MOVE_FPS = 30 as const;

/** 统一 Move Player 的即时停止距离与 Spatial Detector 的稳定到达阈值。 */
export function resolveContinuousStopDistance(
  moveDeadZone: number | undefined,
  spatialArrivalTolerance: number | undefined,
): number {
  return Math.max(0, moveDeadZone ?? 0, spatialArrivalTolerance ?? 0);
}

export type ContinuousMoveFrameInput = {
  distance: number;
  direction: Point2D;
  arrived: boolean;
};

export type ContinuousMoveDecision = {
  direction: MoveDirection;
  action: 'hold' | 'release';
  reason: 'no_spatial' | 'manual_stop' | 'within_stop_distance' | 'arrived' | 'move';
  /** 到达并启用 exitOnArrival 时为 false，表示结束持续移动并继续后续节点。 */
  shouldContinue: boolean;
};

export function directionFromVector(vector: Point2D): Exclude<MoveDirection, 'stop'> | 'stop' {
  if (Math.hypot(vector.x, vector.y) < 1e-6) return 'stop';
  if (Math.abs(vector.x) >= Math.abs(vector.y)) {
    return vector.x >= 0 ? 'right' : 'left';
  }
  return vector.y >= 0 ? 'down' : 'up';
}

/** 计算持续移动控制的单帧动作。无论本帧移动、释放或丢帧，闭环都继续运行。 */
export function decideContinuousMoveFrame(
  spatial: ContinuousMoveFrameInput | null,
  options: {
    directionMode: 'auto' | 'manual';
    direction: MoveDirection;
    stopDistance: number;
    releaseWhenArrived: boolean;
    exitOnArrival: boolean;
  },
): ContinuousMoveDecision {
  const release = (reason: ContinuousMoveDecision['reason']): ContinuousMoveDecision => {
    const reachedTarget = reason === 'within_stop_distance' || reason === 'arrived';
    return {
      direction: 'stop',
      action: 'release',
      reason,
      shouldContinue: !(options.exitOnArrival && reachedTarget),
    };
  };

  if (!spatial) return release('no_spatial');
  if (spatial.distance <= Math.max(0, options.stopDistance)) return release('within_stop_distance');
  if (options.releaseWhenArrived && spatial.arrived) return release('arrived');

  const direction = options.directionMode === 'manual'
    ? options.direction
    : directionFromVector(spatial.direction);
  if (direction === 'stop') return release('manual_stop');
  return {
    direction,
    action: 'hold',
    reason: 'move',
    shouldContinue: true,
  };
}
