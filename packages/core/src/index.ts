export type NodeType =
  | 'click'
  | 'input'
  | 'wait'
  | 'screenshot'
  | 'if'
  | 'loop'
  | 'recognize';

export type PortDirection = 'input' | 'output';

export type PortDefinition = {
  id: string;
  label: string;
  direction: PortDirection;
  dataType: string;
  required?: boolean;
};

export type WorkflowNodeBase<TType extends NodeType, TData extends Record<string, unknown>> = {
  id: string;
  type: TType;
  title: string;
  description?: string;
  position: {
    x: number;
    y: number;
  };
  width?: number;
  height?: number;
  enabled: boolean;
  data: TData;
};

export type ClickNode = WorkflowNodeBase<'click', {
  // click节点完全依赖识别节点的输出，自己不配置策略
}>;

export type InputNode = WorkflowNodeBase<'input', {
  value: string;
  submit?: boolean;
}>;

export type WaitNode = WorkflowNodeBase<'wait', {
  mode: 'delay' | 'condition';
  delayMs?: number;
  conditionText?: string;
}>;

export type ScreenshotNode = WorkflowNodeBase<'screenshot', {
  regionMode: 'full' | 'selected';
}>;

export type IfNode = WorkflowNodeBase<'if', {
  expression: string;
}>;

export type LoopNode = WorkflowNodeBase<'loop', {
  mode: 'count' | 'condition';
  count?: number;
  conditionText?: string;
}>;

export type RecognizeNode = WorkflowNodeBase<'recognize', {
  strategies: {
    coords: { enabled: boolean; x: number; y: number };
    template: { enabled: boolean; templatePath?: string; threshold: number };
    yolo: { enabled: boolean; modelPath?: string; label?: string; threshold: number };
    ocr: { enabled: boolean; text: string; threshold: number };
    cloudApi: { enabled: boolean; url: string; apiKey: string; prompt: string; threshold: number };
  };
  executionMode: 'cascade' | 'parallel';
  strategyOrder: ('coords' | 'template' | 'yolo' | 'ocr' | 'cloudApi')[];
}>;

export type WorkflowNode = ClickNode | InputNode | WaitNode | ScreenshotNode | IfNode | LoopNode | RecognizeNode;

export type WorkflowEdge = {
  id: string;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
};

export type WorkflowDocument = {
  version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export const defaultWorkflowDocument = (): WorkflowDocument => ({
  version: 1,
  nodes: [],
  edges: [],
});

export const createNodePorts = (type: WorkflowNode['type']): PortDefinition[] => {
  switch (type) {
    case 'click':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'input':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'wait':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'screenshot':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    case 'if':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'true', label: 'True', direction: 'output', dataType: 'flow' },
        { id: 'false', label: 'False', direction: 'output', dataType: 'flow' },
      ];
    case 'loop':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'body', label: 'Body', direction: 'output', dataType: 'flow' },
        { id: 'done', label: 'Done', direction: 'output', dataType: 'flow' },
      ];
    case 'recognize':
      return [
        { id: 'in', label: 'In', direction: 'input', dataType: 'flow' },
        { id: 'out', label: 'Out', direction: 'output', dataType: 'flow' },
      ];
    default:
      return [];
  }
};

export const createDefaultNode = (type: WorkflowNode['type'], index = 1): WorkflowNode => {
  const base = {
    id: `${type}-${Date.now()}-${index}`,
    type,
    title: type.toUpperCase(),
    position: { x: 100 + index * 20, y: 100 + index * 20 },
    enabled: true,
  } as const;

  switch (type) {
    case 'click':
      return {
        ...base,
        type,
        title: 'Click',
        data: { targetStrategy: 'coords', threshold: 60, x: 0, y: 0 },
      };
    case 'input':
      return {
        ...base,
        type,
        title: 'Input',
        data: { value: '', submit: false },
      };
    case 'wait':
      return {
        ...base,
        type,
        title: 'Wait',
        data: { mode: 'delay', delayMs: 1000 },
      };
    case 'screenshot':
      return {
        ...base,
        type,
        title: 'Screenshot',
        data: { regionMode: 'full' },
      };
    case 'if':
      return {
        ...base,
        type,
        title: 'If',
        data: { expression: 'true' },
      };
    case 'loop':
      return {
        ...base,
        type,
        title: 'Loop',
        data: { mode: 'count', count: 3 },
      };
    case 'recognize':
      return {
        ...base,
        type,
        title: 'Recognize',
        data: {
          strategies: {
            coords: { enabled: true, x: 0, y: 0 },
            template: { enabled: false, threshold: 60 },
            yolo: { enabled: false, threshold: 60 },
            ocr: { enabled: false, text: '', threshold: 60 },
            cloudApi: { enabled: false, url: '', apiKey: '', prompt: '', threshold: 60 },
          },
          executionMode: 'cascade',
          strategyOrder: ['coords', 'template', 'yolo', 'ocr', 'cloudApi'],
        },
      };
  }
};