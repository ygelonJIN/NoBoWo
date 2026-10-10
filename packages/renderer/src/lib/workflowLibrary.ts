import type { WorkflowDocument } from '@nobowo/core';

const WORKFLOW_LIBRARY_KEY = 'nobowo.workflow.library.v1';
const ACTIVE_WORKFLOW_KEY = 'nobowo.workflow.active.v1';

export type StoredWorkflow = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  document: WorkflowDocument;
};

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `workflow-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function cloneDocument(document: WorkflowDocument): WorkflowDocument {
  return JSON.parse(JSON.stringify(document)) as WorkflowDocument;
}

export function isWorkflowDocument(value: unknown): value is WorkflowDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<WorkflowDocument>;
  return document.version === 1 && Array.isArray(document.nodes) && Array.isArray(document.edges);
}

export function readWorkflowLibrary(): StoredWorkflow[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WORKFLOW_LIBRARY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is StoredWorkflow => {
        if (!item || typeof item !== 'object') return false;
        const workflow = item as Partial<StoredWorkflow>;
        return (
          typeof workflow.id === 'string' &&
          typeof workflow.name === 'string' &&
          typeof workflow.createdAt === 'number' &&
          typeof workflow.updatedAt === 'number' &&
          isWorkflowDocument(workflow.document)
        );
      })
      .map((workflow) => ({ ...workflow, document: cloneDocument(workflow.document) }));
  } catch {
    return [];
  }
}

function writeWorkflowLibrary(workflows: StoredWorkflow[]): void {
  window.localStorage.setItem(WORKFLOW_LIBRARY_KEY, JSON.stringify(workflows, null, 2));
}

export function createStoredWorkflow(name: string, document: WorkflowDocument): StoredWorkflow {
  const now = Date.now();
  const workflow: StoredWorkflow = {
    id: createId(),
    name: name.trim() || '未命名工作流',
    createdAt: now,
    updatedAt: now,
    document: cloneDocument(document),
  };
  writeWorkflowLibrary([workflow, ...readWorkflowLibrary()]);
  return workflow;
}

export function ensureActiveStoredWorkflow(document: WorkflowDocument): StoredWorkflow {
  const activeWorkflowId = readActiveWorkflowId();
  const existing = readWorkflowLibrary().find((workflow) => workflow.id === activeWorkflowId);
  if (existing) return existing;
  const workflow = createStoredWorkflow('当前工作流', document);
  writeActiveWorkflowId(workflow.id);
  return workflow;
}

export function updateStoredWorkflowDocument(id: string, document: WorkflowDocument): void {
  const workflows = readWorkflowLibrary();
  writeWorkflowLibrary(
    workflows.map((workflow) =>
      workflow.id === id
        ? { ...workflow, updatedAt: Date.now(), document: cloneDocument(document) }
        : workflow,
    ),
  );
}

export function renameStoredWorkflow(id: string, name: string): void {
  const workflows = readWorkflowLibrary();
  writeWorkflowLibrary(
    workflows.map((workflow) =>
      workflow.id === id
        ? { ...workflow, name: name.trim() || workflow.name, updatedAt: Date.now() }
        : workflow,
    ),
  );
}

export function deleteStoredWorkflow(id: string): void {
  writeWorkflowLibrary(readWorkflowLibrary().filter((workflow) => workflow.id !== id));
}

export function readActiveWorkflowId(): string | null {
  return window.localStorage.getItem(ACTIVE_WORKFLOW_KEY);
}

export function writeActiveWorkflowId(id: string | null): void {
  if (id) {
    window.localStorage.setItem(ACTIVE_WORKFLOW_KEY, id);
  } else {
    window.localStorage.removeItem(ACTIVE_WORKFLOW_KEY);
  }
}
