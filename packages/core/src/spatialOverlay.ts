import type { SpatialResult, VisionOverlayMarker, YoloDetection } from './index';

export const SPATIAL_PLAYER_COLOR = '#50e6ff';
export const SPATIAL_TARGET_COLOR = '#ffb020';
export const SPATIAL_OTHER_COLOR = '#9aa7b2';

/** Build one frame's overlay markers. A new frame replaces the previous payload; empty detections clear old boxes. */
export function buildSpatialOverlayMarkers(
  detections: YoloDetection[],
  spatial?: SpatialResult,
): VisionOverlayMarker[] {
  const markers: VisionOverlayMarker[] = detections.map((detection) => {
    const [x, y, width, height] = detection.box;
    const isPlayer = spatial?.playerBox?.every((value, index) => value === detection.box[index]) ?? false;
    const isTarget = spatial?.targetBox?.every((value, index) => value === detection.box[index]) ?? false;
    return {
      kind: 'box',
      x,
      y,
      width,
      height,
      label: isPlayer ? `Player · ${detection.label}` : isTarget ? `Target · ${detection.label}` : detection.label,
      confidence: detection.confidence,
      color: isPlayer ? SPATIAL_PLAYER_COLOR : isTarget ? SPATIAL_TARGET_COLOR : SPATIAL_OTHER_COLOR,
    };
  });
  if (spatial) {
    markers.push({
      kind: 'point',
      x: spatial.player.image.x,
      y: spatial.player.image.y,
      label: 'Player',
      color: SPATIAL_PLAYER_COLOR,
    });
    markers.push({
      kind: 'point',
      x: spatial.target.image.x,
      y: spatial.target.image.y,
      label: 'Target',
      color: SPATIAL_TARGET_COLOR,
    });
  }
  return markers;
}
