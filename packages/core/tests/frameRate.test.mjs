import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STREAM_FRAME_RATES,
  formatFrameRateSetting,
  normalizeFrameRateSetting,
  resolveFrameRateSetting,
} from '../dist/frameRate.js';

test('frame-rate choices are uniformly limited to 30 and 60 FPS', () => {
  assert.deepEqual([...STREAM_FRAME_RATES], [30, 60]);
  assert.equal(normalizeFrameRateSetting(30), 30);
  assert.equal(normalizeFrameRateSetting(60), 60);
  assert.equal(normalizeFrameRateSetting('source'), 'source');
});

test('legacy arbitrary FPS values normalize to the shared 30 FPS preset', () => {
  assert.equal(normalizeFrameRateSetting(10), 30);
  assert.equal(resolveFrameRateSetting(10, 60), 30);
  assert.equal(formatFrameRateSetting(10), '30 FPS');
});

test('source mode follows a known 30 or 60 FPS capture source', () => {
  assert.equal(resolveFrameRateSetting('source', 30), 30);
  assert.equal(resolveFrameRateSetting('source', 60), 60);
  assert.equal(resolveFrameRateSetting('source', undefined), 30);
});
