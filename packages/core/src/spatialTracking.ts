import type { YoloDetection } from './index';

export type SpatialObservation = {
  detection: YoloDetection;
  seenAt: number;
};

export type SpatialObservationStore = {
  player?: SpatialObservation;
  target?: SpatialObservation;
};

export type SpatialObservationUpdate = {
  store: SpatialObservationStore;
  sawPlayer: boolean;
  sawTarget: boolean;
  ready: boolean;
  progress: boolean;
};

function pickBestDetection(
  detections: YoloDetection[],
  label: string,
): YoloDetection | null {
  const wanted = label.trim();
  if (!wanted) return null;
  const matches = detections.filter((item) => item.label === wanted);
  return matches.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

export function updateSpatialObservations(
  current: SpatialObservationStore,
  detections: YoloDetection[],
  playerLabel: string,
  targetLabel: string,
  seenAt: number,
): SpatialObservationUpdate {
  const store: SpatialObservationStore = { ...current };
  const player = pickBestDetection(detections, playerLabel);
  const target = pickBestDetection(detections, targetLabel);
  let progress = false;

  if (player) {
    const previous = store.player;
    if (
      !previous ||
      previous.detection.confidence < player.confidence ||
      previous.detection.box.some((value, index) => value !== player.box[index])
    ) {
      progress = true;
    }
    store.player = { detection: player, seenAt };
  }

  if (target) {
    const previous = store.target;
    if (
      !previous ||
      previous.detection.confidence < target.confidence ||
      previous.detection.box.some((value, index) => value !== target.box[index])
    ) {
      progress = true;
    }
    store.target = { detection: target, seenAt };
  }

  return {
    store,
    sawPlayer: player !== null,
    sawTarget: target !== null,
    ready: Boolean(store.player && store.target),
    progress,
  };
}

export function summarizeSpatialObservations(
  store: SpatialObservationStore,
  playerLabel: string,
  targetLabel: string,
): string {
  const describe = (
    observation: SpatialObservation | undefined,
    label: string,
  ) => observation
    ? `${label} ${observation.detection.confidence.toFixed(1)}%`
    : `${label} 等待中`;
  return `${describe(store.player, playerLabel)}，${describe(store.target, targetLabel)}`;
}

export function createPartialSpatialResult(
  nodeId: string,
  store: SpatialObservationStore,
  playerLabel: string,
  targetLabel: string,
): {
  nodeId: string;
  status: 'ok';
  partial: true;
  spatialReady: false;
  message: string;
} {
  return {
    nodeId,
    status: 'ok',
    partial: true,
    spatialReady: false,
    message: summarizeSpatialObservations(store, playerLabel, targetLabel),
  };
}
