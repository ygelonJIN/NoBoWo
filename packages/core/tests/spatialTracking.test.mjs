import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPartialSpatialResult,
  summarizeSpatialObservations,
  updateSpatialObservations,
} from '../dist/spatialTracking.js';

const detection = (label, confidence, x) => ({
  label,
  confidence,
  box: [x, 100, 40, 20],
});

test('one observed class is retained without requiring the other class', () => {
  const first = updateSpatialObservations(
    {},
    [detection('指示器', 72, 10)],
    '指示器',
    '罚球线',
    1000,
  );

  assert.equal(first.ready, false);
  assert.equal(first.sawPlayer, true);
  assert.equal(first.sawTarget, false);
  assert.equal(first.store.player?.detection.confidence, 72);
  assert.equal(first.store.target, undefined);
  assert.match(summarizeSpatialObservations(first.store, '指示器', '罚球线'), /罚球线 等待中/);
  assert.deepEqual(createPartialSpatialResult('spatial-1', first.store, '指示器', '罚球线'), {
    nodeId: 'spatial-1',
    status: 'ok',
    partial: true,
    spatialReady: false,
    message: '指示器 72.0%，罚球线 等待中',
  });
});

test('target seen on another frame completes the cached spatial pair', () => {
  const playerOnly = updateSpatialObservations(
    {},
    [detection('指示器', 68, 20)],
    '指示器',
    '罚球线',
    1000,
  );
  const targetLater = updateSpatialObservations(
    playerOnly.store,
    [detection('罚球线', 61, 220)],
    '指示器',
    '罚球线',
    1800,
  );

  assert.equal(targetLater.ready, true);
  assert.equal(targetLater.sawPlayer, false);
  assert.equal(targetLater.sawTarget, true);
  assert.equal(targetLater.store.player?.seenAt, 1000);
  assert.equal(targetLater.store.target?.seenAt, 1800);
});

test('both labels can arrive in either order and later frames refresh one side', () => {
  const targetOnly = updateSpatialObservations(
    {},
    [detection('罚球线', 64, 240)],
    '指示器',
    '罚球线',
    100,
  );
  const playerLater = updateSpatialObservations(
    targetOnly.store,
    [detection('指示器', 70, 15)],
    '指示器',
    '罚球线',
    200,
  );
  const refreshedPlayer = updateSpatialObservations(
    playerLater.store,
    [detection('指示器', 76, 18)],
    '指示器',
    '罚球线',
    300,
  );

  assert.equal(playerLater.ready, true);
  assert.equal(refreshedPlayer.ready, true);
  assert.equal(refreshedPlayer.store.player?.detection.confidence, 76);
  assert.equal(refreshedPlayer.store.target?.seenAt, 100);
});
