import type { MoveDirection, Point2D } from './index';

/** 持续移动闭环固定按用户约定的每秒30帧执行。 */
export const CONTINUOUS_MOVE_FPS = 30 as const;

export type ContinuousMoveFrameInput = {
  distance: number;
  direction: Point2D;
  arrived: boolean;
};

export type ContinuousMoveDecision = {
  direction: MoveDirection;
  action: 'hold' | 'release';
  reason: 'no_spatial' | 'manual_stop' | 'within_stop_distance' | 'arrived' | 'move';
  /** 持续控制帧只决定本帧输入，不产生节点终止条件。 */
  shouldContinue: true;
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
  },
): ContinuousMoveDecision {
  const release = (reason: ContinuousMoveDecision['reason']): ContinuousMoveDecision => ({
    direction: 'stop',
    action: 'release',
    reason,
    shouldContinue: true,
  });

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
