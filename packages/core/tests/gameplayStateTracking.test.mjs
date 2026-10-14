import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGameplayStateTracker,
  updateGameplayStateTracker,
} from '../dist/gameplayStateTracking.js';

test('offense state requires consecutive confirmation frames', () => {
  let tracker = createGameplayStateTracker();
  let first = updateGameplayStateTracker(tracker, 'offense', 3, 2);
  tracker = first.tracker;
  assert.equal(tracker.state, 'unknown');

  let second = updateGameplayStateTracker(tracker, 'offense', 3, 2);
  tracker = second.tracker;
  assert.equal(tracker.state, 'unknown');

  let third = updateGameplayStateTracker(tracker, 'offense', 3, 2);
  tracker = third.tracker;
  assert.equal(tracker.state, 'offense');
  assert.equal(third.changed, true);
});

test('confirmed state survives short unknown gaps', () => {
  let tracker = { state: 'defense', candidate: null, candidateFrames: 0, holdFrames: 0 };
  const first = updateGameplayStateTracker(tracker, 'unknown', 3, 2);
  tracker = first.tracker;
  assert.equal(tracker.state, 'defense');
  assert.equal(first.changed, false);

  const second = updateGameplayStateTracker(tracker, 'unknown', 3, 2);
  tracker = second.tracker;
  assert.equal(tracker.state, 'unknown');
  assert.equal(second.changed, true);
});
