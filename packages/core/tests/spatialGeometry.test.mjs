import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSpatialMovement,
  closestPointsBetweenBoxes,
  closestPointOnPolyline,
} from '../dist/spatialGeometry.js';

test('polyline target projects to the nearest segment point', () => {
  const nearest = closestPointOnPolyline(
    { x: 500, y: 500 },
    [{ x: 200, y: 700 }, { x: 500, y: 620 }, { x: 800, y: 700 }],
  );
  assert.deepEqual(nearest, { x: 500, y: 620 });
});

test('movement slows down as the target approaches', () => {
  const far = calculateSpatialMovement(240, { x: 0, y: -1 }, {
    minMagnitude: 0.2,
    maxMagnitude: 0.7,
    deadZone: 5,
    brakeDistance: 120,
  });
  const near = calculateSpatialMovement(30, { x: 0, y: -1 }, {
    minMagnitude: 0.2,
    maxMagnitude: 0.7,
    deadZone: 5,
    brakeDistance: 120,
  });
  assert.equal(far.magnitude, 0.7);
  assert.ok(near.magnitude > 0.2 && near.magnitude < far.magnitude);
  assert.deepEqual(far.vector, { x: 0, y: -0.7 });
});

test('movement becomes neutral inside the dead zone', () => {
  const movement = calculateSpatialMovement(0, { x: 1, y: 0 }, {
    minMagnitude: 0.2,
    maxMagnitude: 0.7,
    deadZone: 5,
    brakeDistance: 120,
  });
  assert.deepEqual(movement, { vector: { x: 0, y: 0 }, magnitude: 0 });
});

test('selected target edge ignores nearer perpendicular side edges', () => {
  const playerBox = [150, 150, 20, 20];
  const targetBox = [100, 100, 200, 20];

  const nearest = closestPointsBetweenBoxes(playerBox, targetBox);
  const top = closestPointsBetweenBoxes(playerBox, targetBox, 'top');
  const bottom = closestPointsBetweenBoxes(playerBox, targetBox, 'bottom');

  assert.equal(nearest.distance, 30);
  assert.equal(top.distance, 50);
  assert.equal(bottom.distance, 30);
  assert.deepEqual(top.target, { x: 160, y: 100 });
});
