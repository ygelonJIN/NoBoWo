import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { WorkflowNode } from '@nobowo/core';

export function WorkflowNodeView({ data }: NodeProps<WorkflowNode>) {
  return (
    <div className={`workflow-node workflow-node--${data.type}`}>
      <div className="workflow-node__title">{data.title}</div>
      <div className="workflow-node__body">{data.description ?? '未配置'}</div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}