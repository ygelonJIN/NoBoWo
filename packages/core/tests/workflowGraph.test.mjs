import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRouteFailureToIf,
  classifyLoopBodyTarget,
  combineParallelWorkflowChainEnds,
  createParallelWorkflowContexts,
  findWorkflowEdgeBySource,
  findWorkflowEdgesBySource,
  ifBranchForPreviousStatus,
  isUntilBreakLoop,
  runParallelWorkflowBranches,
  resolveLoopPair,
} from '../dist/workflowGraph.js';

const loop = (id, role, pairId) => ({
  id,
  type: 'loop',
  title: role === 'begin' ? 'Loop Begin' : 'Loop Down',
  position: { x: 0, y: 0 },
  enabled: true,
  data: { mode: 'count', count: 3, role, pairId },
});

test('explicit loop ports select body, feedback and sequential edges independently', () => {
  const edges = [
    { id: 'legacy', source: 'down', sourcePort: 'out', target: 'legacy-next', targetPort: 'in' },
    { id: 'body', source: 'begin', sourcePort: 'body', target: 'body-first', targetPort: 'in' },
    { id: 'again', source: 'down', sourcePort: 'again', target: 'begin', targetPort: 'again' },
    { id: 'next', source: 'down', sourcePort: 'next', target: 'after', targetPort: 'in' },
  ];

  assert.equal(findWorkflowEdgeBySource(edges, 'begin', 'body')?.target, 'body-first');
  assert.equal(findWorkflowEdgeBySource(edges, 'down', 'again')?.target, 'begin');
  assert.equal(findWorkflowEdgeBySource(edges, 'down', 'next')?.target, 'after');
});

test('one output port can fan out to multiple independent branches', () => {
  const edges = [
    { id: 'yolo', source: 'wait', sourcePort: 'out', target: 'yolo', targetPort: 'in' },
    { id: 'ocr', source: 'wait', sourcePort: 'out', target: 'ocr', targetPort: 'in' },
    { id: 'other', source: 'elsewhere', sourcePort: 'out', target: 'other', targetPort: 'in' },
  ];

  assert.deepEqual(
    findWorkflowEdgesBySource(edges, 'wait', 'out').map((edge) => edge.target),
    ['yolo', 'ocr'],
  );
});

test('parallel workflow branches start together and all complete', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const branch = (value) => async () => {
    started += 1;
    await gate;
    return value;
  };

  const pending = runParallelWorkflowBranches([branch('yolo'), branch('ocr')]);
  await Promise.resolve();
  assert.equal(started, 2);
  release();

  assert.deepEqual(await pending, {
    results: ['yolo', 'ocr'],
    maxConcurrent: 2,
  });
});

test('parallel branches receive isolated mutable context copies', () => {
  const parent = { lastResult: null, lastRecognize: null };
  const contexts = createParallelWorkflowContexts(parent, (source) => ({ ...source }), 2);

  contexts[0].lastRecognize = { target: 'A' };
  contexts[1].lastRecognize = { target: 'B' };
  contexts[1].lastResult = { status: 'ok' };

  assert.deepEqual(contexts[0], { lastResult: null, lastRecognize: { target: 'A' } });
  assert.deepEqual(contexts[1], { lastResult: { status: 'ok' }, lastRecognize: { target: 'B' } });
  assert.deepEqual(parent, { lastResult: null, lastRecognize: null });
});

test('a loop body allows an effect branch to end when its control branch reaches Loop Down', async () => {
  const branchRun = await runParallelWorkflowBranches([
    async () => 'complete',
    async () => 'boundary',
  ]);

  assert.equal(combineParallelWorkflowChainEnds(branchRun.results), 'boundary');
  assert.equal(combineParallelWorkflowChainEnds(['complete', 'continue']), 'continue');
  assert.equal(combineParallelWorkflowChainEnds(['complete', 'complete']), 'complete');
  assert.equal(combineParallelWorkflowChainEnds(['boundary', 'stopped']), 'stopped');
});

test('feedback ports pair nested loops without crossing loop boundaries', () => {
  const nodes = [
    loop('outer-begin', 'begin', 'outer'),
    loop('outer-down', 'down', 'outer'),
    loop('inner-begin', 'begin', 'inner'),
    loop('inner-down', 'down', 'inner'),
  ];
  const edges = [
    { id: 'outer-back', source: 'outer-down', sourcePort: 'again', target: 'outer-begin', targetPort: 'again' },
    { id: 'inner-back', source: 'inner-down', sourcePort: 'again', target: 'inner-begin', targetPort: 'again' },
  ];

  assert.deepEqual(resolveLoopPair(nodes, edges, nodes[0]), { begin: nodes[0], down: nodes[1] });
  assert.deepEqual(resolveLoopPair(nodes, edges, nodes[3]), { begin: nodes[2], down: nodes[3] });
});

test('pairId still pairs legacy loops without explicit feedback ports', () => {
  const nodes = [loop('begin', 'begin', 'legacy-pair'), loop('down', 'down', 'legacy-pair')];
  assert.deepEqual(resolveLoopPair(nodes, [], nodes[0]), { begin: nodes[0], down: nodes[1] });
});

test('If routes by the directly previous node result', () => {
  assert.equal(ifBranchForPreviousStatus('ok'), 'true');
  assert.equal(ifBranchForPreviousStatus('fail'), 'false');
  assert.equal(ifBranchForPreviousStatus('skipped'), 'false');
  assert.equal(ifBranchForPreviousStatus(undefined), 'false');
});

test('a failed node may continue only when its next node is If', () => {
  assert.equal(canRouteFailureToIf({ type: 'if' }), true);
  assert.equal(canRouteFailureToIf({ type: 'wait' }), false);
  assert.equal(canRouteFailureToIf(null), false);
});

test('untilBreak loop mode is explicit', () => {
  assert.equal(isUntilBreakLoop({ data: { mode: 'untilBreak' } }), true);
  assert.equal(isUntilBreakLoop({ data: { mode: 'count' } }), false);
});

test('untilBreak treats body back edges as Continue and Loop Down as Break', () => {
  const base = { beginId: 'begin', downId: 'down', beginNext: 'first', visited: new Set(['first', 'retry']) };
  assert.deepEqual(
    classifyLoopBodyTarget({ ...base, current: 'retry', untilBreak: true }),
    { kind: 'continue', target: 'retry' },
  );
  assert.deepEqual(
    classifyLoopBodyTarget({ ...base, current: 'begin', untilBreak: true }),
    { kind: 'continue', target: 'first' },
  );
  assert.deepEqual(
    classifyLoopBodyTarget({ ...base, current: 'down', untilBreak: true }),
    { kind: 'break' },
  );
});

test('structured loop mode still rejects body back edges', () => {
  const base = { beginId: 'begin', downId: 'down', beginNext: 'first', visited: new Set(['retry']) };
  assert.equal(classifyLoopBodyTarget({ ...base, current: 'retry', untilBreak: false }).kind, 'error');
  assert.deepEqual(
    classifyLoopBodyTarget({ ...base, current: 'down', untilBreak: false }),
    { kind: 'end-iteration' },
  );
});

test('If branches may converge on the same Wait input without losing T/F routing', () => {
  const edges = [
    { id: 'true-wait', source: 'if', sourcePort: 'true', target: 'wait', targetPort: 'in' },
    { id: 'false-wait', source: 'if', sourcePort: 'false', target: 'wait', targetPort: 'in' },
    { id: 'wait-next', source: 'wait', sourcePort: 'out', target: 'after', targetPort: 'in' },
  ];

  assert.equal(findWorkflowEdgeBySource(edges, 'if', 'true')?.target, 'wait');
  assert.equal(findWorkflowEdgeBySource(edges, 'if', 'false')?.target, 'wait');
  assert.equal(findWorkflowEdgeBySource(edges, 'wait', 'out')?.target, 'after');
});

test('an If branch can enter an inner loop while the other branch converges later', () => {
  const nodes = [
    loop('inner-begin', 'begin', 'inner'),
    loop('inner-down', 'down', 'inner'),
  ];
  const edges = [
    { id: 'true-loop', source: 'if', sourcePort: 'true', target: 'inner-begin', targetPort: 'in' },
    { id: 'false-wait', source: 'if', sourcePort: 'false', target: 'wait', targetPort: 'in' },
    { id: 'body', source: 'inner-begin', sourcePort: 'body', target: 'wait', targetPort: 'in' },
    { id: 'wait-down', source: 'wait', sourcePort: 'out', target: 'inner-down', targetPort: 'in' },
    { id: 'back', source: 'inner-down', sourcePort: 'again', target: 'inner-begin', targetPort: 'again' },
    { id: 'next', source: 'inner-down', sourcePort: 'next', target: 'after', targetPort: 'in' },
  ];

  assert.equal(findWorkflowEdgeBySource(edges, 'if', 'true')?.target, 'inner-begin');
  assert.equal(findWorkflowEdgeBySource(edges, 'if', 'false')?.target, 'wait');
  assert.deepEqual(resolveLoopPair(nodes, edges, nodes[0]), { begin: nodes[0], down: nodes[1] });
  assert.equal(findWorkflowEdgeBySource(edges, 'wait', 'out')?.target, 'inner-down');
  assert.equal(findWorkflowEdgeBySource(edges, 'inner-down', 'next')?.target, 'after');
});
