import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTINUOUS_MOVE_FPS, decideContinuousMoveFrame } from '../dist/movementControl.js';

const options = {
  directionMode: 'auto',
  direction: 'stop',
  stopDistance: 10,
  releaseWhenArrived: true,
};

const frame = (distance, arrived = false) => ({
  distance,
  direction: { x: 0, y: -1 },
  arrived,
});

test('continuous movement runs at the required 30 frames per second', () => {
  assert.equal(CONTINUOUS_MOVE_FPS, 30);
});

test('continuous movement holds across distant frames without terminating', () => {
  for (const distance of [100, 90, 80]) {
    const decision = decideContinuousMoveFrame(frame(distance), options);
    assert.equal(decision.action, 'hold');
    assert.equal(decision.direction, 'up');
    assert.equal(decision.shouldContinue, true);
  }
});

test('reaching the stop distance releases input but keeps the loop alive', () => {
  const decision = decideContinuousMoveFrame(frame(10), options);
  assert.deepEqual(decision, {
    direction: 'stop',
    action: 'release',
    reason: 'within_stop_distance',
    shouldContinue: true,
  });
});

test('movement resumes automatically after the player drifts away again', () => {
  const near = decideContinuousMoveFrame(frame(10), options);
  const far = decideContinuousMoveFrame(frame(20), options);
  assert.equal(near.action, 'release');
  assert.equal(near.shouldContinue, true);
  assert.equal(far.action, 'hold');
  assert.equal(far.direction, 'up');
  assert.equal(far.shouldContinue, true);
});

test('missing spatial data releases input without ending continuous control', () => {
  const decision = decideContinuousMoveFrame(null, options);
  assert.equal(decision.action, 'release');
  assert.equal(decision.reason, 'no_spatial');
  assert.equal(decision.shouldContinue, true);
});
