import { useEffect, useRef, useState } from 'react';
import { defaultWorkflowDocument, type WorkflowDocument } from '@nobowo/core';
import {
  createStoredWorkflow,
  deleteStoredWorkflow,
  isWorkflowDocument,
  readWorkflowLibrary,
  renameStoredWorkflow,
  type StoredWorkflow,
} from '../lib/workflowLibrary';

type Props = {
  currentDocument: WorkflowDocument;
  activeWorkflowId: string | null;
  onClose: () => void;
  onOpenWorkflow: (workflow: StoredWorkflow) => void;
  onActiveWorkflowChange: (id: string | null) => void;
};

function exportDocument(name: string, document: WorkflowDocument): void {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[\\/:*?"<>|]/g, '-') || 'workflow'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function WorkflowManagerModal({
  currentDocument,
  activeWorkflowId,
  onClose,
  onOpenWorkflow,
  onActiveWorkflowChange,
}: Props) {
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>(() => readWorkflowLibrary());
  const [selectedId, setSelectedId] = useState<string | null>(activeWorkflowId);
  const [draftName, setDraftName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? null;
  const isNew = !selected;
  const editorDocument = isNew ? defaultWorkflowDocument() : currentDocument;

  useEffect(() => {
    setDraftName(selected?.name ?? '');
    setConfirmDelete(false);
    setError(null);
  }, [selected?.id, selected?.name]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const refresh = () => setWorkflows(readWorkflowLibrary());

  const startNew = () => {
    setSelectedId(null);
    setDraftName('');
    setConfirmDelete(false);
    setError(null);
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const selectWorkflow = (workflow: StoredWorkflow) => {
    setSelectedId(workflow.id);
    setDraftName(workflow.name);
    setConfirmDelete(false);
    setError(null);
    onActiveWorkflowChange(workflow.id);
    onOpenWorkflow(workflow);
  };

  const createWorkflow = () => {
    const name = draftName.trim();
    if (!name) {
      setError('请输入工作流名称');
      nameInputRef.current?.focus();
      return;
    }

    const workflow = createStoredWorkflow(name, editorDocument);
    onActiveWorkflowChange(workflow.id);
    onOpenWorkflow(workflow);
    setSelectedId(workflow.id);
    setError(null);
    refresh();
  };

  const changeName = (name: string) => {
    setDraftName(name);
    setError(null);
    if (!selected) return;
    renameStoredWorkflow(selected.id, name);
    setWorkflows((current) =>
      current.map((workflow) =>
        workflow.id === selected.id ? { ...workflow, name: name.trim() || workflow.name } : workflow,
      ),
    );
  };

  const removeWorkflow = () => {
    if (!selected) return;
    deleteStoredWorkflow(selected.id);
    if (selected.id === activeWorkflowId) onActiveWorkflowChange(null);
    setSelectedId(null);
    setDraftName('');
    setConfirmDelete(false);
    setError(null);
    refresh();
  };

  const importWorkflow = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        if (!isWorkflowDocument(parsed)) {
          setError('无法识别的文件格式，请选择 NoBoWo 导出的工作流 JSON');
          return;
        }
        const workflow = createStoredWorkflow(file.name.replace(/\.json$/i, ''), parsed);
        onActiveWorkflowChange(workflow.id);
        onOpenWorkflow(workflow);
        setSelectedId(workflow.id);
        setDraftName(workflow.name);
        setError(null);
        refresh();
      } catch {
        setError('文件解析失败，请选择有效的工作流 JSON 文件');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="template-modal__overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="template-modal cloud-api-modal workflow-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-manager-title"
      >
        <header className="template-modal__header">
          <div>
            <h2 id="workflow-manager-title">工作流管理</h2>
            <p>当前画布会自动保存到工作流，导入和导出也在这里完成</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="yolo-btn--ghost yolo-btn--compact" onClick={() => importInputRef.current?.click()}>
              导入工作流
            </button>
            <button
              className="yolo-btn--ghost yolo-btn--compact"
              onClick={() => exportDocument(selected?.name ?? draftName ?? '新建工作流', editorDocument)}
            >
              导出工作流
            </button>
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="cloud-api-modal__body">
          <aside className="cloud-api-modal__sidebar">
            <div className="cloud-api-modal__sidebar-head">
              <span className="template-modal__section-title">工作流列表</span>
              <span className="template-modal__list-count">{workflows.length}</span>
            </div>
            <button className="template-folder-new-card" onClick={startNew}>
              <span className="template-folder-new-card__icon">＋</span>
              <span className="template-folder-new-card__text">新建工作流</span>
            </button>
            <div className="cloud-api-modal__cards">
              {workflows.map((workflow) => {
                const active = workflow.id === activeWorkflowId;
                return (
                  <button
                    key={workflow.id}
                    className={`cloud-api-card ${workflow.id === selectedId ? 'cloud-api-card--active' : ''}`}
                    onClick={() => selectWorkflow(workflow)}
                  >
                    <div className="cloud-api-card__head">
                      <span className="cloud-api-card__name">{workflow.name}</span>
                      <span className={`cloud-api-card__pill ${active ? 'ok' : 'idle'}`}>
                        {active ? '当前画布' : '已保存'}
                      </span>
                    </div>
                    <div className="cloud-api-card__meta">
                      {workflow.document.nodes.length} 个节点 · {workflow.document.edges.length} 条连接 · {new Date(workflow.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                );
              })}
              {workflows.length === 0 && (
                <div className="cloud-api-modal__empty">还没有工作流，点击“新建工作流”创建空白画布。</div>
              )}
            </div>
          </aside>

          <section className="cloud-api-modal__editor">
            <div className="workflow-manager-modal__section-head">
              <div className="template-modal__step">{isNew ? '1 · 新建工作流' : '1 · 工作流信息'}</div>
              {selected && (
                <span className="cloud-delete-controls" onClick={(event) => event.stopPropagation()}>
                  {confirmDelete ? (
                    <>
                      <button className="delete-confirm__ok" onClick={removeWorkflow}>确定</button>
                      <button className="delete-confirm__cancel" onClick={() => setConfirmDelete(false)}>取消</button>
                    </>
                  ) : (
                    <button className="delete-trigger delete-trigger--visible" onClick={() => setConfirmDelete(true)}>
                      删除工作流
                    </button>
                  )}
                </span>
              )}
            </div>
            <div className="panel-card">
              <div className="cloud-api-form">
                <label className="template-form__field cloud-api-form__wide">
                  工作流名称
                  <input
                    ref={nameInputRef}
                    value={draftName}
                    onChange={(event) => changeName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && isNew) createWorkflow();
                    }}
                    placeholder="例如：每日签到流程"
                    maxLength={80}
                  />
                </label>
              </div>
            </div>

            <div className="template-modal__step">2 · 画布内容</div>
            <div className="cloud-api-modal__test">
              <p className="cloud-api-modal__status-msg">
                <span className={`cloud-api-modal__status ${isNew ? 'idle' : 'ok'}`}>
                  {isNew ? '待创建' : '已保存'}
                </span>
                <span className="cloud-api-modal__status-sub">
                  {editorDocument.nodes.length} 个节点 · {editorDocument.edges.length} 条连接
                </span>
                {isNew ? '创建空白画布，之后可继续添加节点和连接。' : '画布修改会自动同步到当前工作流。'}
              </p>
            </div>

            {error && <div className="cloud-api-modal__error">{error}</div>}

            {isNew && (
              <div className="template-modal__footer">
                <button className="template-modal__save" onClick={createWorkflow}>
                  创建工作流
                </button>
              </div>
            )}
          </section>
        </div>

        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importWorkflow(file);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
