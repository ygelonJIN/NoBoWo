import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateDefinition, TemplateFolder, TemplateRect } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';
import { TemplateCropEditor } from './TemplateCropEditor';
import { TemplateThumb } from './TemplateThumb';
import { EnvPanel } from './EnvPanel';

type Props = {
  onClose: () => void;
  onChanged: () => void;
};

type EditState = {
  editing: TemplateDefinition | null;
  sourceImage: string | null;
  sourceRect: TemplateRect | null;
  clickOffset: ClickOffset;
  name: string;
  otherNotes: string;
  app: string;
  appZoom: string;
  folderId: string | null;
  tags: string;
  windowTitle: string;
  matchHotspot: TemplateRect | null;
  resolutionW: number;
  resolutionH: number;
  scaleFactor: number;
  saving: boolean;
  error: string | null;
};

const blankEdit = (): EditState => ({
  editing: null,
  sourceImage: null,
  sourceRect: null,
  clickOffset: { x: 0, y: 0 },
  name: '',
  otherNotes: '',
  app: '',
  appZoom: '',
  folderId: null,
  tags: '',
  windowTitle: '',
  matchHotspot: null,
  resolutionW: window.screen?.width ?? 1920,
  resolutionH: window.screen?.height ?? 1080,
  scaleFactor: window.devicePixelRatio || 1,
  saving: false,
  error: null,
});

function cropToDataUrl(imageUrl: string, rect: TemplateRect): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建画布'));
        return;
      }
      ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('截图读取失败'));
    img.src = imageUrl;
  });
}

function normalizeTags(text: string) {
  return [...new Set(text.split(/[，,\n]/).map((v) => v.trim()).filter(Boolean))].join('，');
}

export function TemplateManagerModal({ onClose, onChanged }: Props) {
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [folders, setFolders] = useState<TemplateFolder[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(blankEdit);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newFolder, setNewFolder] = useState('');
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [batchReplace, setBatchReplace] = useState(false);
  const [renameFolderId, setRenameFolderId] = useState<string | null>(null);
  const [renameFolderName, setRenameFolderName] = useState('');
  const [tab, setTab] = useState<'folders' | 'annotate' | 'env'>('folders');
  const [tool, setTool] = useState<'draw' | 'move'>('draw');
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingReplaceRef = useRef(false);
  const apiUnavailable = !window.templateAPI;

  const refreshList = useCallback(async () => {
    if (!window.templateAPI) return;
    try {
      const data = await window.templateAPI.list();
      setTemplates(data.templates);
      setFolders(data.folders);
      setSelectedId((cur) => (cur && data.templates.some((t) => t.id === cur) ? cur : data.templates[0]?.id ?? null));
    } catch {
      setTemplates([]);
      setFolders([]);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const readFile = useCallback((file: File, keepEditing = false) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      setEdit((prev) => ({
        ...prev,
        editing: keepEditing ? prev.editing : null,
        sourceImage: String(reader.result),
        sourceRect: null,
        clickOffset: { x: 0, y: 0 },
        folderId: keepEditing ? prev.folderId : activeFolderId,
        name: keepEditing ? prev.name : file.name.replace(/\.[^.]+$/, '') || prev.name,
        resolutionW: window.screen?.width ?? prev.resolutionW,
        resolutionH: window.screen?.height ?? prev.resolutionH,
        scaleFactor: window.devicePixelRatio || prev.scaleFactor,
        error: null,
      }));
      if (!keepEditing) setSelectedId(null);
      setTab('annotate');
    };
    reader.readAsDataURL(file);
  }, [activeFolderId]);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const keepEditing = pendingReplaceRef.current;
      pendingReplaceRef.current = false;
      if (batchReplace && selectedIds.length > 0) {
        void window.templateAPI?.batchUpdate(selectedIds, { notes: `待替换来源截图：${file.name}` }).then(() => refreshList());
        setBatchReplace(false);
      } else {
        readFile(file, keepEditing);
      }
      e.target.value = '';
    },
    [batchReplace, readFile, refreshList, selectedIds],
  );

  const openTemplate = useCallback(async (tpl: TemplateDefinition) => {
    setSelectedId(tpl.id);
    setConfirmDeleteId(null);
    setSelectedIds((prev) => (prev.includes(tpl.id) ? prev : [tpl.id]));
    setTab('annotate');
    let source: string | null = null;
    if (window.templateAPI) {
      try {
        source = await window.templateAPI.getImage(tpl.id, 'source');
      } catch {
        source = null;
      }
    }
    setEdit({
      editing: tpl,
      sourceImage: source,
      sourceRect: tpl.sourceRect,
      clickOffset: tpl.clickOffset,
      name: tpl.name,
      otherNotes: tpl.notes ?? '',
      app: tpl.app ?? '',
      appZoom: tpl.appZoom ?? '',
      folderId: tpl.folderId ?? null,
      tags: (tpl.tags ?? []).join('，'),
      windowTitle: tpl.windowTitle ?? '',
      matchHotspot: tpl.matchHotspot ?? null,
      resolutionW: tpl.resolution.width,
      resolutionH: tpl.resolution.height,
      scaleFactor: tpl.scaleFactor,
      saving: false,
      error: null,
    });
  }, []);

  const startNew = useCallback(() => {
    setSelectedId(null);
    setConfirmDeleteId(null);
    pendingReplaceRef.current = false;
    setEdit({ ...blankEdit(), folderId: activeFolderId });
  }, [activeFolderId]);

  const handleNewTemplate = useCallback(() => {
    setBatchReplace(false);
    startNew();
    fileInputRef.current?.click();
  }, [startNew]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) readFile(file);
    },
    [readFile],
  );

  const handleSave = useCallback(async () => {
    if (!edit.name.trim() || !edit.sourceRect) return;
    setEdit((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const meta = {
        name: edit.name.trim(),
        notes: edit.otherNotes.trim() || undefined,
        app: edit.app.trim() || undefined,
        appZoom: edit.appZoom.trim() || undefined,
        folderId: edit.folderId,
        tags: normalizeTags(edit.tags).split('，').map((v) => v.trim()).filter(Boolean),
        windowTitle: edit.windowTitle.trim() || undefined,
        matchHotspot: edit.matchHotspot ?? edit.sourceRect,
        resolution: { width: edit.resolutionW, height: edit.resolutionH },
        scaleFactor: edit.scaleFactor,
        clickOffset: edit.clickOffset,
        sourceRect: edit.sourceRect,
      };

      if (edit.editing && window.templateAPI) {
        const imageDataUrl = edit.sourceImage
          ? await cropToDataUrl(edit.sourceImage, edit.sourceRect)
          : undefined;
        await window.templateAPI.update(edit.editing.id, {
          ...meta,
          imageDataUrl,
          sourceDataUrl: edit.sourceImage ?? undefined,
        });
        setEdit((prev) => ({ ...prev, saving: false }));
      } else if (edit.sourceImage && window.templateAPI) {
        const imageDataUrl = await cropToDataUrl(edit.sourceImage, edit.sourceRect);
        await window.templateAPI.create({
          ...meta,
          imageDataUrl,
          sourceDataUrl: edit.sourceImage,
        });
        setSelectedId(null);
        setEdit(blankEdit());
      } else {
        setEdit((prev) => ({ ...prev, saving: false, error: '模板库不可用' }));
        return;
      }

      await refreshList();
      onChanged();
    } catch (err) {
      setEdit((prev) => ({ ...prev, saving: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, [edit, onChanged, refreshList]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.templateAPI) return;
      await window.templateAPI.remove(id);
      if (selectedId === id) {
        setSelectedId(null);
        setEdit(blankEdit());
      }
      setConfirmDeleteId(null);
      setTemplates((list) => list.filter((t) => t.id !== id));
      setSelectedIds((ids) => ids.filter((v) => v !== id));
      onChanged();
    },
    [onChanged, selectedId],
  );

  const createFolder = async () => {
    if (!window.templateAPI || !newFolder.trim()) return;
    try {
      const folder = await window.templateAPI.createFolder({ name: newFolder.trim(), parentId: null });
      setFolders((current) => [...current, folder]);
      setNewFolder('');
      setFolderCreateOpen(false);
      setActiveFolderId(folder.id);
    } catch (err) {
      setEdit((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const startRenameFolder = (folder: TemplateFolder) => {
    setRenameFolderId(folder.id);
    setRenameFolderName(folder.name);
    setConfirmDeleteFolderId(null);
  };

  const commitRenameFolder = async () => {
    if (!window.templateAPI || !renameFolderId) return;
    const name = renameFolderName.trim();
    if (name) {
      try {
        await window.templateAPI.updateFolder(renameFolderId, { name });
      } catch (err) {
        setEdit((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    setRenameFolderId(null);
    setRenameFolderName('');
    await refreshList();
  };

  const deleteFolder = async (id: string) => {
    if (!window.templateAPI) return;
    try {
      await window.templateAPI.removeFolder(id, null);
    } catch (err) {
      setEdit((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    }
    setConfirmDeleteFolderId(null);
    setRenameFolderId(null);
    if (activeFolderId === id) setActiveFolderId(null);
    await refreshList();
  };

  const filtered = templates.filter((t) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.app, t.notes, t.windowTitle, ...(t.tags ?? [])].some((v) => v?.toLowerCase().includes(q));
  });

  const activeTemplates = filtered.filter((tpl) => (activeFolderId ? tpl.folderId === activeFolderId : true));
  const halfW = edit.sourceRect ? Math.round(edit.sourceRect.width / 2) : 0;
  const halfH = edit.sourceRect ? Math.round(edit.sourceRect.height / 2) : 0;
  const canSave = Boolean(edit.name.trim() && edit.sourceRect) && !apiUnavailable;
  const enabledCount = activeTemplates.filter((t) => t.enabled !== false).length;
  const tagTotal = new Set(activeTemplates.flatMap((t) => t.tags ?? [])).size;
  const currentIdx = Math.max(0, activeTemplates.findIndex((t) => t.id === selectedId));
  const boxCount = edit.sourceRect ? 1 : 0;

  const goPrevTemplate = () => {
    const idx = activeTemplates.findIndex((t) => t.id === selectedId);
    if (idx > 0) void openTemplate(activeTemplates[idx - 1]);
  };

  const goNextTemplate = () => {
    const idx = activeTemplates.findIndex((t) => t.id === selectedId);
    if (idx >= 0 && idx < activeTemplates.length - 1) void openTemplate(activeTemplates[idx + 1]);
  };


  const updateField = <K extends keyof EditState>(key: K, value: EditState[K]) =>
    setEdit((prev) => ({ ...prev, [key]: value }));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
    setSelectedId(id);
  };

  return (
    <div
      className="template-modal__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="template-modal template-modal--wide template-manager" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="yolo-modal__header">
          <div className="yolo-modal__title">
            <h2>模板管理</h2>
            <p>按文件夹组织模板，框选目标区域，供识别节点的「模板匹配」策略使用</p>
          </div>
          <div className="yolo-modal__training-pill">
            <span className="status-dot status-dot--saved" />
            {templates.length} 个模板
          </div>
          <button className="yolo-modal__close" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <nav className="yolo-modal__tabs">
          <button className={`yolo-modal__tab ${tab === 'folders' ? 'active' : ''}`} onClick={() => setTab('folders')}>
            <span className="yolo-modal__tab-label">模板库</span>
            {templates.length > 0 && <span className="yolo-modal__tab-badge">{templates.length}</span>}
            <span className="yolo-modal__tab-hint">文件夹与模板列表</span>
          </button>
          <button className={`yolo-modal__tab ${tab === 'annotate' ? 'active' : ''}`} onClick={() => setTab('annotate')}>
            <span className="yolo-modal__tab-label">标注</span>
            <span className="yolo-modal__tab-hint">框选目标并设置属性</span>
          </button>
          <button className={`yolo-modal__tab ${tab === 'env' ? 'active' : ''}`} onClick={() => setTab('env')}>
            <span className="yolo-modal__tab-label">环境</span>
            <span className="yolo-modal__tab-hint">模板匹配依赖（OpenCV）</span>
          </button>
        </nav>

        <div className="yolo-modal__body template-manager__body">
          {tab === 'folders' && (
            <div className="yolo-dataset template-dataset">
              <aside className="yolo-dataset__list">
                <div className="yolo-panel-title">
                  <span>文件夹</span>
                  <span className="yolo-panel-title__sub">{folders.length} 个</span>
                </div>
                <input
                  className="yolo-dataset__search"
                  placeholder="搜索模板、标签、应用名…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {folderCreateOpen ? (
                  <div className="yolo-dataset__create">
                    <input
                      autoFocus
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFolder();
                        if (e.key === 'Escape') setFolderCreateOpen(false);
                      }}
                      placeholder="文件夹名称…"
                    />
                    <div className="yolo-dataset__create-actions">
                      <button onClick={() => void createFolder()} disabled={!newFolder.trim()}>确定</button>
                      <button onClick={() => setFolderCreateOpen(false)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <button className="yolo-dataset__new" onClick={() => setFolderCreateOpen(true)}>
                    ＋ 新建文件夹
                  </button>
                )}
                <div className="yolo-dataset__items">
                  {folders.map((folder) => (
                    <div key={folder.id} className={`yolo-dataset__item delete-hover ${activeFolderId === folder.id ? 'active' : ''} ${confirmDeleteFolderId === folder.id ? 'confirming' : ''}`} onClick={() => setActiveFolderId(folder.id)}>
                      <div className="yolo-dataset__item-main">
                        <div className="yolo-dataset__item-head">
                          {renameFolderId === folder.id ? (
                            <input
                              className="yolo-dataset__rename-input"
                              autoFocus
                              value={renameFolderName}
                              onChange={(e) => setRenameFolderName(e.target.value)}
                              onBlur={() => void commitRenameFolder()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void commitRenameFolder();
                                if (e.key === 'Escape') setRenameFolderId(null);
                              }}
                            />
                          ) : (
                            <span className="yolo-dataset__item-name">{folder.name}</span>
                          )}
                          <span className="yolo-dataset__item-meta">{templates.filter((t) => t.folderId === folder.id).length} 个</span>
                        </div>
                        <div className="yolo-dataset__item-actions delete-hover" onClick={(e) => e.stopPropagation()}>
                          {renameFolderId === folder.id ? (
                            <>
                              <button className="delete-confirm__ok" onClick={() => void commitRenameFolder()}>确定</button>
                              <button className="delete-confirm__cancel" onClick={() => setRenameFolderId(null)}>取消</button>
                            </>
                          ) : confirmDeleteFolderId === folder.id ? (
                            <>
                              <button className="delete-confirm__ok" onClick={() => void deleteFolder(folder.id)}>确定</button>
                              <button className="delete-confirm__cancel" onClick={() => setConfirmDeleteFolderId(null)}>取消</button>
                            </>
                          ) : (
                            <>
                              <button className="yolo-dataset__rename-btn" onClick={(e) => { e.stopPropagation(); startRenameFolder(folder); }}>重命名</button>
                              <button className="delete-trigger" onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolderId(folder.id); }} title="删除文件夹（其中的模板移到未归类）">删除</button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {folders.length === 0 && <div className="yolo-annotate__empty-hint">还没有文件夹。文件夹用于把同类模板归到一起。</div>}
                </div>
              </aside>

              <section className="yolo-dataset__main">
                {!activeFolderId ? (
                  <div className="yolo-dataset__empty">
                    <div className="yolo-dataset__empty-icon">◈</div>
                    <p>创建或选择一个文件夹，开始上传截图创建模板</p>
                  </div>
                ) : activeTemplates.length === 0 ? (
                  <div className="yolo-dataset__empty yolo-dataset__empty--drop">
                    <div
                      className={`yolo-dataset__drop yolo-dataset__drop--full ${dragOver ? 'drag' : ''}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) readFile(file);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <div className="yolo-dataset__drop-icon">⬆</div>
                      <div className="yolo-dataset__drop-text">拖拽截图到这里，或点击选择文件</div>
                      <div className="yolo-dataset__drop-sub">上传后自动进入「标注」页框选目标区域</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="yolo-dataset__stats">
                      <div className="yolo-stat-card">
                        <span className="yolo-stat-card__value">{activeTemplates.length}</span>
                        <span className="yolo-stat-card__label">模板总数</span>
                      </div>
                      <div className="yolo-stat-card">
                        <span className="yolo-stat-card__value">{enabledCount}</span>
                        <span className="yolo-stat-card__label">已启用</span>
                      </div>
                      <div className="yolo-stat-card">
                        <span className="yolo-stat-card__value">{activeTemplates.length - enabledCount}</span>
                        <span className="yolo-stat-card__label">已停用</span>
                      </div>
                      <div className="yolo-stat-card">
                        <span className="yolo-stat-card__value">{folders.length}</span>
                        <span className="yolo-stat-card__label">文件夹</span>
                      </div>
                      <div className="yolo-stat-card">
                        <span className="yolo-stat-card__value">{tagTotal}</span>
                        <span className="yolo-stat-card__label">标签数</span>
                      </div>
                    </div>

                    <div
                      className={`yolo-dataset__drop ${dragOver ? 'drag' : ''}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) readFile(file);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <div className="yolo-dataset__drop-icon">⬆</div>
                      <div className="yolo-dataset__drop-text">拖拽截图到这里创建新模板，或点击选择文件</div>
                      <div className="yolo-dataset__drop-sub">上传后自动进入「标注」页框选目标区域</div>
                    </div>

                    {edit.error && <div className="yolo-annotate__error">{edit.error}</div>}

                    <div className="yolo-dataset__grid-head">
                      <span className="yolo-panel-title">
                        <span>模板</span>
                        <span className="yolo-panel-title__sub">{activeTemplates.length} 个</span>
                      </span>
                      <div className="yolo-dataset__grid-actions">
                        <button
                          onClick={async () => {
                            if (window.templateAPI && templates.length > 0) await window.templateAPI.export(templates.map((t) => t.id));
                          }}
                          disabled={templates.length === 0}
                          title="导出模板库到本地文件夹"
                        >
                          导出模板库
                        </button>
                        {activeFolderId !== null && (
                          <button className="yolo-btn--danger" onClick={() => setConfirmDeleteFolderId(activeFolderId)}>
                            删除文件夹
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="yolo-dataset__grid">
                      {activeTemplates.map((tpl) => (
                        <div key={tpl.id} className={`yolo-dataset__cell delete-hover ${selectedId === tpl.id ? 'active' : ''}`} onClick={() => void openTemplate(tpl)}>
                          <TemplateThumb id={tpl.id} className="yolo-dataset__cell-img" />
                          <span className="yolo-dataset__cell-delete-controls" onClick={(e) => e.stopPropagation()}>
                            {confirmDeleteId === tpl.id ? (
                              <>
                                <button className="delete-confirm__ok" onClick={() => handleDelete(tpl.id)}>确定</button>
                                <button className="delete-confirm__cancel" onClick={() => setConfirmDeleteId(null)}>取消</button>
                              </>
                            ) : (
                              <button className="delete-trigger" title="删除模板" onClick={() => setConfirmDeleteId(tpl.id)}>删除</button>
                            )}
                          </span>
                          <div className="yolo-dataset__cell-info">
                            <span className="yolo-dataset__cell-name">{tpl.name}</span>
                            <span className={`yolo-dataset__cell-badge ${tpl.enabled !== false ? '' : 'empty'}`}>
                              {tpl.enabled !== false ? '已启用' : '已停用'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {activeTemplates.length === 0 && <div className="yolo-dataset__empty small">这个文件夹还没有模板，拖拽截图到上方创建</div>}
                  </>
                )}
              </section>
            </div>
          )}

          {tab === 'annotate' && (
            <div className="yolo-annotate template-annotate">
              {/* 左：模板缩略图列表 */}
              <aside className="yolo-annotate__thumbs">
                <div className="yolo-panel-title">
                  <span>模板</span>
                  <span className="yolo-panel-title__sub">{activeTemplates.length} 个</span>
                </div>
                <button className="yolo-dataset__new" onClick={handleNewTemplate}>
                  ＋ 上传新截图
                </button>
                <div className="yolo-annotate__thumb-list">
                  {activeTemplates.length === 0 && <div className="yolo-annotate__empty-hint">{activeFolderId === null ? '先选择一个文件夹，再上传模板。' : '还没有模板，点击上方上传第一张截图。'}</div>}
                  {activeTemplates.map((tpl) => (
                    <button key={tpl.id} className={`yolo-annotate__thumb ${selectedId === tpl.id ? 'active' : ''}`} onClick={() => void openTemplate(tpl)}>
                      <TemplateThumb id={tpl.id} className="yolo-annotate__thumb-img" />
                      <div className="yolo-annotate__thumb-info">
                        <span className="yolo-annotate__thumb-name">{tpl.name}</span>
                        <span className={`yolo-annotate__thumb-meta ${tpl.enabled !== false ? '' : 'empty'}`}>
                          {tpl.enabled !== false ? '已启用' : '已停用'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </aside>

              {/* 中：框选画布 */}
              <section className="yolo-annotate__canvas">
                <div className="yolo-annotate__toolbar">
                  <div className="yolo-seg">
                    <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')}>框选</button>
                    <button className={tool === 'move' ? 'active' : ''} onClick={() => setTool('move')}>移动</button>
                  </div>
                  <div className="yolo-annotate__nav">
                    <button onClick={goPrevTemplate} disabled={activeTemplates.length === 0 || currentIdx <= 0}>上一张</button>
                    <span className="yolo-annotate__pos">
                      {activeTemplates.length === 0 ? '0 / 0' : `${currentIdx + 1} / ${activeTemplates.length}`}
                    </span>
                    <button className="yolo-btn--primary" onClick={goNextTemplate} disabled={activeTemplates.length === 0 || currentIdx >= activeTemplates.length - 1}>下一张</button>
                  </div>
                  <div className="yolo-annotate__actions">
                    <span className={`yolo-annotate__savestate ${edit.saving ? 'saving' : ''}`}>{edit.saving ? '保存中…' : '已保存'}</span>
                    <button onClick={handleNewTemplate}>上传新截图</button>
                    {edit.editing && (
                      <button className="yolo-btn--danger" onClick={() => setConfirmDeleteId(edit.editing!.id)} disabled={Boolean(confirmDeleteId)}>
                        删除模板
                      </button>
                    )}
                  </div>
                </div>

                <div className="yolo-annotate__stage-wrap">
                  {edit.sourceImage ? (
                    <TemplateCropEditor
                      imageUrl={edit.sourceImage}
                      rect={edit.sourceRect}
                      offset={edit.clickOffset}
                      tool={tool}
                      onRectChange={(rect) => {
                        updateField('sourceRect', rect);
                        if (rect) {
                          const boundX = Math.round(rect.width / 2);
                          const boundY = Math.round(rect.height / 2);
                          updateField('clickOffset', {
                            x: Math.max(-boundX, Math.min(boundX, edit.clickOffset.x)),
                            y: Math.max(-boundY, Math.min(boundY, edit.clickOffset.y)),
                          });
                        }
                      }}
                      onOffsetChange={(offset) => updateField('clickOffset', offset)}
                    />
                  ) : edit.editing ? (
                    <div className="yolo-stage__empty">该模板没有保存来源截图。可点击「上传新截图」或更换截图后重新框选。</div>
                  ) : (
                    <div className={`template-modal__upload ${dragOver ? 'template-modal__upload--drag' : ''}`} onClick={() => fileInputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); handleDrop(e); }}>
                      <div className="template-modal__upload-icon">＋</div>
                      <div className="template-modal__upload-text">拖拽截图到这里，或点击选择文件</div>
                      <div className="template-modal__upload-hint">支持 PNG / JPG / WebP · 建议截取目标应用的真实画面</div>
                    </div>
                  )}
                </div>

                {/* 状态栏 */}
                <div className="yolo-annotate__status">
                  {edit.editing ? (
                    <>当前图片 {boxCount} 个框 · {edit.editing.name}</>
                  ) : edit.sourceImage ? (
                    <>当前图片 {boxCount} 个框 · 框选目标区域，设置名称后保存</>
                  ) : (
                    <>选择模板或上传新截图开始标注</>
                  )}
                </div>

                {confirmDeleteId && edit.editing && (
                  <div className="yolo-annotate__error">
                    确认删除模板「{edit.editing.name}」？
                    <button className="delete-confirm__ok" onClick={() => handleDelete(edit.editing!.id)}>确定删除</button>
                    <button className="delete-confirm__cancel" onClick={() => setConfirmDeleteId(null)}>取消</button>
                  </div>
                )}
              </section>

              {/* 右：模板属性 */}
              <aside className="yolo-annotate__classes template-annotate__props">
                {edit.editing || edit.sourceImage ? (
                  <>
                    <div className="yolo-panel-title">
                      <span>模板属性</span>
                      <span className="yolo-panel-title__sub">框选目标并设置属性</span>
                    </div>
                    <TemplateForm edit={edit} halfW={halfW} halfH={halfH} canSave={canSave} onChange={updateField} onSave={handleSave} />
                  </>
                ) : (
                  <div className="yolo-annotate__empty-hint">从左侧选择模板开始编辑</div>
                )}
              </aside>
            </div>
          )}

          {tab === 'env' && (
            <div className="template-manager__env">
              <EnvPanel mode="template" onChanged={() => void refreshList()} />
            </div>
          )}
        </div>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleFileInput} />
    </div>
  );
}

type FormProps = {
  edit: EditState;
  halfW: number;
  halfH: number;
  canSave: boolean;
  onChange: <K extends keyof EditState>(key: K, value: EditState[K]) => void;
  onSave: () => void;
};

const SCALE_PRESETS = [
  { value: '1', label: '100%' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
  { value: '1.75', label: '175%' },
  { value: '2', label: '200%' },
];

function TemplateForm({ edit, halfW, halfH, canSave, onChange, onSave }: FormProps) {
  const [customScale, setCustomScale] = useState(false);
  const clampOffset = (axis: 'x' | 'y', value: number) => {
    const bound = axis === 'x' ? halfW : halfH;
    return Math.max(-bound, Math.min(bound, Number.isFinite(value) ? value : 0));
  };
  const isPresetScale = SCALE_PRESETS.some((p) => Number(p.value) === edit.scaleFactor);

  return (
    <div className="template-form">
      <div className="panel-card template-form__stack">
        <label className="template-form__field">
          <span>名称 <span className="template-form__required">*</span></span>
          <input value={edit.name} onChange={(e) => onChange('name', e.target.value)} placeholder="如：提交按钮" />
        </label>

        <label className="template-form__field">
          系统缩放比例
          <CustomSelect
            value={isPresetScale && !customScale ? String(edit.scaleFactor) : 'custom'}
            options={[
              ...SCALE_PRESETS,
              { value: 'custom', label: '自定义…' },
            ]}
            onChange={(v) => {
              if (v === 'custom') {
                setCustomScale(true);
                return;
              }
              setCustomScale(false);
              onChange('scaleFactor', Number(v));
            }}
          />
          {(!isPresetScale || customScale) && (
            <input
              type="number"
              step="0.01"
              min="0.1"
              value={edit.scaleFactor}
              onChange={(e) => onChange('scaleFactor', Number(e.target.value))}
              placeholder="如 1.6"
            />
          )}
        </label>

        <label className="template-form__field">
          系统分辨率
          <div className="template-form__resolution">
            <input type="number" value={edit.resolutionW} onChange={(e) => onChange('resolutionW', Number(e.target.value))} />
            <span>×</span>
            <input type="number" value={edit.resolutionH} onChange={(e) => onChange('resolutionH', Number(e.target.value))} />
          </div>
        </label>

        <label className="template-form__field">
          点击偏移（0, 0 = 匹配区域中心）
          <div className="template-form__offset">
            <input type="number" value={edit.clickOffset.x} onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, x: clampOffset('x', Number(e.target.value)) })} />
            <input type="number" value={edit.clickOffset.y} onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, y: clampOffset('y', Number(e.target.value)) })} />
            <span className="template-form__offset-hint">X {edit.clickOffset.x} / Y {edit.clickOffset.y}</span>
          </div>
        </label>

        <label className="template-form__field">
          备注
          <textarea value={edit.otherNotes} onChange={(e) => onChange('otherNotes', e.target.value)} placeholder="目标应用、窗口标题、标签等…" rows={1} />
        </label>
      </div>

      <div className="template-modal__footer">
        <button className="template-modal__save" onClick={onSave} disabled={!canSave || edit.saving}>
          {edit.saving ? '保存中…' : edit.editing ? '保存修改' : '保存模板'}
        </button>
        {edit.error && <span className="template-modal__error">{edit.error}</span>}
      </div>
    </div>
  );
}
