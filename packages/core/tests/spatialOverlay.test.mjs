import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSpatialOverlayMarkers,
  SPATIAL_OTHER_COLOR,
  SPATIAL_PLAYER_COLOR,
  SPATIAL_TARGET_COLOR,
} from '../dist/spatialOverlay.js';

const detection = (label, box) => ({ label, confidence: 91, box });
const spatial = {
  player: { image: { x: 20, y: 30 } },
  target: { image: { x: 200, y: 30 } },
  playerBox: [10, 20, 20, 20],
  targetBox: [190, 20, 20, 20],
};

test('spatial overlay contains current YOLO boxes and Player/Target crosshairs', () => {
  const markers = buildSpatialOverlayMarkers([
    detection('player', [10, 20, 20, 20]),
    detection('target', [190, 20, 20, 20]),
    detection('ball', [50, 50, 8, 8]),
  ], spatial);

  assert.equal(markers.filter((marker) => marker.kind === 'box').length, 3);
  assert.equal(markers.filter((marker) => marker.kind === 'point').length, 2);
  assert.equal(markers[0].color, SPATIAL_PLAYER_COLOR);
  assert.equal(markers[1].color, SPATIAL_TARGET_COLOR);
  assert.equal(markers[2].color, SPATIAL_OTHER_COLOR);
  assert.deepEqual(markers.slice(3).map((marker) => marker.label), ['Player', 'Target']);
});

test('empty detections produce an empty replacement payload for clearing old boxes', () => {
  assert.deepEqual(buildSpatialOverlayMarkers([], undefined), []);
});
