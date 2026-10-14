export type GameplayStateValue = 'offense' | 'defense' | 'unknown';

export type GameplayStateTracker = {
  state: GameplayStateValue;
  candidate: GameplayStateValue | null;
  candidateFrames: number;
  holdFrames: number;
};

export function createGameplayStateTracker(): GameplayStateTracker {
  return { state: 'unknown', candidate: null, candidateFrames: 0, holdFrames: 0 };
}

/**
 * 将单帧进攻/防守观察转换成带确认帧和保持帧的稳定状态。
 * 连续 confirmFrames 帧观察到另一状态才会切换；已确认状态短暂丢失时保持 holdFrames 帧。
 */
export function updateGameplayStateTracker(
  current: GameplayStateTracker,
  observed: GameplayStateValue,
  confirmFrames: number,
  holdFrames: number,
): { tracker: GameplayStateTracker; changed: boolean; rawChanged: boolean } {
  const requiredConfirmFrames = Math.max(1, Math.round(confirmFrames));
  const requiredHoldFrames = Math.max(0, Math.round(holdFrames));
  const tracker = { ...current };
  const previousState = current.state;
  const rawChanged = observed !== previousState;

  if (observed === previousState) {
    tracker.candidate = null;
    tracker.candidateFrames = 0;
    tracker.holdFrames = 0;
    return { tracker, changed: false, rawChanged };
  }

  if (observed === 'unknown') {
    tracker.candidate = null;
    tracker.candidateFrames = 0;
    tracker.holdFrames = current.holdFrames + 1;
    if (current.state !== 'unknown' && tracker.holdFrames >= requiredHoldFrames) {
      tracker.state = 'unknown';
      tracker.holdFrames = 0;
    }
    return { tracker, changed: tracker.state !== previousState, rawChanged };
  }

  tracker.holdFrames = 0;
  if (current.candidate === observed) {
    tracker.candidateFrames = current.candidateFrames + 1;
  } else {
    tracker.candidate = observed;
    tracker.candidateFrames = 1;
  }

  if (tracker.candidateFrames >= requiredConfirmFrames) {
    tracker.state = observed;
    tracker.candidate = null;
    tracker.candidateFrames = 0;
  }
  return { tracker, changed: tracker.state !== previousState, rawChanged };
}
