import type { LoopNode, NodeRunStatus, WorkflowEdge, WorkflowNode } from './index';

export type FlowSourcePort = 'out' | 'true' | 'false' | 'body' | 'again' | 'next';
export type FlowTargetPort = 'in' | 'again';

function sourcePortOf(edge: WorkflowEdge): string {
  return edge.sourcePort ?? 'out';
}

function targetPortOf(edge: WorkflowEdge): string {
  return edge.targetPort ?? 'in';
}

/** 返回指定输出端口的全部流程边；同一端口连接多个后继时表示并行分叉。 */
export function findWorkflowEdgesBySource(
  edges: WorkflowEdge[],
  nodeId: string,
  port: FlowSourcePort,
): WorkflowEdge[] {
  const candidates = edges.filter((edge) => edge.source === nodeId);
  if (port === 'body') {
    const explicit = candidates.filter((edge) => sourcePortOf(edge) === 'body');
    return explicit.length > 0 ? explicit : candidates.filter((edge) => sourcePortOf(edge) === 'out');
  }
  if (port === 'next') {
    const explicit = candidates.filter((edge) => sourcePortOf(edge) === 'next');
    return explicit.length > 0 ? explicit : candidates.filter((edge) => sourcePortOf(edge) === 'out');
  }
  return candidates.filter((edge) => sourcePortOf(edge) === port);
}

/** 按显式端口选择流程边；兼容旧工作流中 Loop Begin/Down 的默认 out。 */
export function findWorkflowEdgeBySource(
  edges: WorkflowEdge[],
  nodeId: string,
  port: FlowSourcePort,
): WorkflowEdge | undefined {
  return findWorkflowEdgesBySource(edges, nodeId, port)[0];
}

export function findWorkflowEdgeByTarget(
  edges: WorkflowEdge[],
  nodeId: string,
  port: FlowTargetPort = 'in',
): WorkflowEdge | undefined {
  return edges.find((edge) => edge.target === nodeId && targetPortOf(edge) === port);
}

/** If 只判断直接前一个节点的最终状态：仅 ok 走 True，其余状态都走 False。 */
export function ifBranchForPreviousStatus(status: NodeRunStatus | undefined): 'true' | 'false' {
  return status === 'ok' ? 'true' : 'false';
}

/** 失败节点后面直接接 If 时，失败结果交给 If 分流，不作为执行错误中止流程。 */
export function canRouteFailureToIf(nextNode: Pick<WorkflowNode, 'type'> | null | undefined): boolean {
  return nextNode?.type === 'if';
}

export type ParallelWorkflowBranchRun<T> = {
  results: T[];
  /** 实际同时运行的分支峰值，用于验证并行分叉而不是顺序执行。 */
  maxConcurrent: number;
};

export type WorkflowChainEnd = 'complete' | 'boundary' | 'continue' | 'stopped';

/**
 * 汇总并行分支的结束状态。
 * 普通副作用分支可以自行结束；任一控制分支到达 Loop Down 或回边继续即可结束本轮循环。
 */
export function combineParallelWorkflowChainEnds(
  ends: ReadonlyArray<WorkflowChainEnd>,
): WorkflowChainEnd {
  if (ends.includes('stopped')) return 'stopped';
  if (ends.includes('boundary')) return 'boundary';
  if (ends.includes('continue')) return 'continue';
  return 'complete';
}

/** 为并行分支创建互不共享可变字段的上下文副本。 */
export function createParallelWorkflowContexts<T>(
  parent: T,
  cloneContext: (context: T) => T,
  branchCount: number,
): T[] {
  return Array.from({ length: Math.max(0, branchCount) }, () => cloneContext(parent));
}

/** 并行启动工作流分支，所有分支完成后统一返回。 */
export async function runParallelWorkflowBranches<T>(
  branches: ReadonlyArray<() => Promise<T>>,
): Promise<ParallelWorkflowBranchRun<T>> {
  let active = 0;
  let maxConcurrent = 0;
  const results = await Promise.all(branches.map(async (branch) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    try {
      return await branch();
    } finally {
      active -= 1;
    }
  }));
  return { results, maxConcurrent };
}

export function isUntilBreakLoop(node: Pick<LoopNode, 'data'>): boolean {
  return node.data.mode === 'untilBreak';
}

export type LoopBodyTargetAction =
  | { kind: 'run'; target: string }
  | { kind: 'break' }
  | { kind: 'end-iteration' }
  | { kind: 'continue'; target: string }
  | { kind: 'error'; message: string };

/** untilBreak 中，循环体回边表示 Continue，进入配对 Loop Down 表示 Break。 */
export function classifyLoopBodyTarget(input: {
  current: string | null;
  beginId: string;
  downId: string;
  beginNext: string;
  visited: ReadonlySet<string>;
  untilBreak: boolean;
}): LoopBodyTargetAction {
  const { current, beginId, downId, beginNext, visited, untilBreak } = input;
  if (!current) return { kind: 'error', message: '循环体断开，没有到达 Loop Down' };
  if (current === downId) return untilBreak ? { kind: 'break' } : { kind: 'end-iteration' };
  if (current === beginId || visited.has(current)) {
    if (untilBreak) {
      return { kind: 'continue', target: current === beginId ? beginNext : current };
    }
    return { kind: 'error', message: '循环体出现额外回路，请只连接到 Loop Down' };
  }
  return { kind: 'run', target: current };
}

export function resolveLoopPair(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  node: LoopNode,
): { begin: LoopNode; down: LoopNode } | null {
  const loops = nodes.filter((candidate): candidate is LoopNode => candidate.type === 'loop');
  const wantedRole = node.data.role === 'begin' ? 'down' : 'begin';

  if (node.data.role === 'begin') {
    const feedbackDown = loops.find((candidate) => {
      if (candidate.data.role !== 'down') return false;
      const feedback = findWorkflowEdgeBySource(edges, candidate.id, 'again');
      return feedback?.target === node.id && targetPortOf(feedback) === 'again';
    });
    if (feedbackDown) return { begin: node, down: feedbackDown };
  } else {
    const feedback = findWorkflowEdgeBySource(edges, node.id, 'again');
    const feedbackBegin = feedback && targetPortOf(feedback) === 'again'
      ? loops.find((candidate) => candidate.id === feedback.target && candidate.data.role === 'begin')
      : undefined;
    if (feedbackBegin) return { begin: feedbackBegin, down: node };
  }

  const pairedById = loops.find((candidate) =>
    candidate.id !== node.id && candidate.data.role === wantedRole && candidate.data.pairId && candidate.data.pairId === node.data.pairId,
  );
  if (pairedById) {
    return node.data.role === 'begin'
      ? { begin: node, down: pairedById }
      : { begin: pairedById, down: node };
  }

  return null;
}
