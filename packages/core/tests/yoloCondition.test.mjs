import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateYoloCondition } from '../dist/yoloCondition.js';

const sample = (at, confidence = 80, label = '投篮条') => ({
  at,
  detections: confidence === null ? [] : [{ label, confidence }],
});

test('YOLO If can detect class presence and absence', () => {
  const present = evaluateYoloCondition(
    [sample(1000)],
    { label: '投篮条', mode: 'present', threshold: 0, stableFrames: 1 },
    1000,
  );
  assert.equal(present.ready, true);
  assert.equal(present.branch, 'true');
  assert.equal(present.bestConfidence, 80);

  const absent = evaluateYoloCondition(
    [sample(1000, null)],
    { label: '投篮条', mode: 'absent', threshold: 0, stableFrames: 1 },
    1000,
  );
  assert.equal(absent.branch, 'true');
});

test('YOLO If evaluates the requested confidence threshold', () => {
  const rule = { label: '投篮条', mode: 'confidenceAtLeast', threshold: 75, stableFrames: 1 };
  assert.equal(evaluateYoloCondition([sample(1000, 74)], rule, 1000).branch, 'false');
  assert.equal(evaluateYoloCondition([sample(1000, 75)], rule, 1000).branch, 'true');
});

test('YOLO If requires the configured number of consecutive frames', () => {
  const rule = { label: '指示器', mode: 'present', threshold: 0, stableFrames: 3, maxFrameGapMs: 500 };
  const incomplete = evaluateYoloCondition(
    [sample(1000, 80, '指示器'), sample(1100, 82, '指示器')],
    rule,
    1100,
  );
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.branch, 'false');

  const complete = evaluateYoloCondition(
    [
      sample(1000, 80, '指示器'),
      sample(1100, 82, '指示器'),
      sample(1200, 84, '指示器'),
    ],
    rule,
    1200,
  );
  assert.equal(complete.ready, true);
  assert.equal(complete.branch, 'true');
  assert.equal(complete.consecutiveMatches, 3);
});

test('YOLO If does not merge samples separated by a stale gap', () => {
  const result = evaluateYoloCondition(
    [sample(1000), sample(1100), sample(2200)],
    { label: '投篮条', mode: 'present', threshold: 0, stableFrames: 3, maxFrameGapMs: 500 },
    2200,
  );
  assert.equal(result.ready, false);
  assert.equal(result.branch, 'false');
});

test('one bad frame resets a consecutive positive run', () => {
  const result = evaluateYoloCondition(
    [sample(1000), sample(1100), sample(1200, null), sample(1300)],
    { label: '投篮条', mode: 'present', threshold: 0, stableFrames: 3, maxFrameGapMs: 500 },
    1300,
  );
  assert.equal(result.ready, true);
  assert.equal(result.branch, 'false');
  assert.equal(result.consecutiveMatches, 1);
});

test('YOLO If can ask whether a label was seen within a time window', () => {
  const rule = {
    label: '投篮条',
    mode: 'present',
    threshold: 0,
    stableFrames: 1,
    timingMode: 'recentWindow',
    windowMs: 3000,
  };
  const recent = evaluateYoloCondition(
    [sample(7000), sample(9000, null)],
    rule,
    10000,
  );
  assert.equal(recent.ready, true);
  assert.equal(recent.branch, 'true');
  assert.equal(recent.windowMs, 3000);

  const stale = evaluateYoloCondition(
    [sample(6000), sample(6500)],
    rule,
    10000,
  );
  assert.equal(stale.ready, true);
  assert.equal(stale.branch, 'false');
});

test('YOLO If absence requires full time-window coverage', () => {
  const rule = {
    label: '投篮条',
    mode: 'absent',
    threshold: 0,
    stableFrames: 1,
    timingMode: 'recentWindow',
    windowMs: 2000,
  };
  const incomplete = evaluateYoloCondition([sample(9000, null)], rule, 10000);
  assert.equal(incomplete.ready, false);

  const covered = evaluateYoloCondition(
    [sample(8000, null), sample(9000, null)],
    rule,
    10000,
  );
  assert.equal(covered.ready, true);
  assert.equal(covered.branch, 'true');

  const seenInsideWindow = evaluateYoloCondition(
    [sample(8000, null), sample(9000, 90)],
    rule,
    10000,
  );
  assert.equal(seenInsideWindow.ready, true);
  assert.equal(seenInsideWindow.branch, 'false');
});
