import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowStateMachine } from '../dist/workflowState.js';

test('state node routes stateA and stateB to separate outputs', () => {
  const state = new WorkflowStateMachine();

  assert.equal(state.get(), 'stateA');
  assert.equal(state.route(), 'true');

  state.set('stateB');
  assert.equal(state.route(), 'false');
});

test('switching before Loop Down affects the next loop iteration', () => {
  const state = new WorkflowStateMachine('stateA');

  state.set('stateB');
  assert.equal(state.route(), 'false');
  state.set('stateA');
  assert.equal(state.route(), 'true');
});

test('toggle switches whichever state is current to the other one', () => {
  const state = new WorkflowStateMachine('stateA');

  assert.equal(state.toggle(), 'stateB');
  assert.equal(state.toggle(), 'stateA');
});
