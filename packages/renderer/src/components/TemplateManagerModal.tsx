import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateDefinition, TemplateFolder, TemplateRect } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';
import { TemplateCropEditor } from './TemplateCropEditor';
import { TemplateThumb } from './TemplateThumb';

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
        name: keepEditing ? prev.name : file.name.replace(/\.[^.]+$/, '') || prev.name,
        resolutionW: window.screen?.width ?? prev.resolutionW,
        resolutionH: window.screen?.height ?? prev.resolutionH,
        scaleFactor: window.devicePixelRatio || prev.scaleFactor,
        error: null,
      }));
      if (!keepEditing) setSelectedId(null);
    };
    reader.readAsDataURL(file);
  }, []);

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
      <div className="template-modal template-modal--wide" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="template-modal__header">
          <div>
            <h2>模板管理</h2>
            <p>按文件夹组织模板，支持批量操作、热区预览、来源截图与识别节点接入</p>
          </div>
          <div className="template-modal__header-actions">
            <button className="template-modal__close" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <div className="template-modal__toolbar">
          <input className="template-modal__search" placeholder="搜索模板、标签、应用名…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="template-modal__toolbar-meta">已选 {selectedIds.length} 项</div>
        </div>

        {selectedIds.length > 0 && (
          <div className="template-modal__batchbar">
            <span>批量操作</span>
            <button onClick={async () => {
              if (!window.templateAPI || !window.confirm(`确定删除选中的 ${selectedIds.length} 个模板吗？`)) return;
              await window.templateAPI.batchDelete(selectedIds);
              setSelectedIds([]);
              setSelectedId(null);
              setEdit(blankEdit());
              await refreshList();
              onChanged();
            }}>批量删除</button>
            <button onClick={async () => {
              const tags = window.prompt('输入要追加的标签（用逗号分隔）');
              if (!window.templateAPI || !tags?.trim()) return;
              const current = new Set(tags.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean));
              await window.templateAPI.batchUpdate(selectedIds, { tags: [...current] });
              await refreshList();
            }}>批量打标签</button>
            <button onClick={async () => { if (window.templateAPI) await window.templateAPI.export(selectedIds); }}>批量导出</button>
            <button onClick={() => { setBatchReplace(true); fileInputRef.current?.click(); }}>批量替换来源截图</button>
            <button onClick={async () => {
              if (!window.templateAPI) return;
              const shouldEnable = selectedIds.some((id) => templates.find((t) => t.id === id)?.enabled !== true);
              await window.templateAPI.batchUpdate(selectedIds, { enabled: shouldEnable });
              await refreshList();
            }}>批量{selectedIds.some((id) => templates.find((t) => t.id === id)?.enabled !== true) ? '启用' : '禁用'}</button>
          </div>
        )}

        <div className="template-modal__body template-modal__body--grid">
          <aside className="template-modal__folders">
            <div className="template-modal__folders-head">
              <span className="template-modal__section-title">文件夹</span>
            </div>
            <div className="template-modal__folders-list">
              {folderCreateOpen ? (
                <div className="template-folder--create">
                  <input
                    value={newFolder}
                    autoFocus
                    onChange={(e) => setNewFolder(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createFolder();
                      if (e.key === 'Escape') setFolderCreateOpen(false);
                    }}
                    placeholder="新文件夹名…"
                  />
                  <div className="template-folder__actions">
                    <button onClick={() => void createFolder()} disabled={!newFolder.trim()}>确定</button>
                    <button onClick={() => setFolderCreateOpen(false)}>取消</button>
                  </div>
                </div>
              ) : (
                <button className="template-folder-new-card" onClick={() => { setFolderCreateOpen(true); setRenameFolderId(null); }}>
                  <span className="template-folder-new-card__icon">＋</span>
                  <span className="template-folder-new-card__text">新建文件夹</span>
                </button>
              )}
              <button className={`template-folder ${activeFolderId === null ? 'active' : ''}`} onClick={() => setActiveFolderId(null)}>
                <span className="template-folder__name">全部模板</span>
                <span className="template-folder__count">{templates.length}</span>
              </button>
              {folders.map((folder) => (
                <div key={folder.id} className={`template-folder-row delete-hover ${activeFolderId === folder.id ? 'active' : ''} ${confirmDeleteFolderId === folder.id ? 'template-folder-row--confirm' : ''}`}>
                  {renameFolderId === folder.id ? (
                    <input
                      className="template-folder__rename"
                      value={renameFolderName}
                      autoFocus
                      onChange={(e) => setRenameFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRenameFolder();
                        if (e.key === 'Escape') setRenameFolderId(null);
                      }}
                      onBlur={() => void commitRenameFolder()}
                    />
                  ) : (
                    <button className="template-folder" onClick={() => setActiveFolderId(folder.id)}>
                      <span className="template-folder__name">{folder.name}</span>
                      <span className="template-folder__count">{templates.filter((t) => t.folderId === folder.id).length}</span>
                    </button>
                  )}
                  <span className="template-folder__tools delete-hover">
                    {confirmDeleteFolderId === folder.id ? (
                      <>
                        <button className="delete-confirm__ok" onClick={() => void deleteFolder(folder.id)}>确定</button>
                        <button className="delete-confirm__cancel" onClick={() => setConfirmDeleteFolderId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button className="template-folder__rename-btn" title="重命名文件夹" onClick={() => startRenameFolder(folder)}>重命名</button>
                        <button className="delete-trigger" title="删除文件夹（其中的模板移到未归类）" onClick={() => setConfirmDeleteFolderId(folder.id)}>删除</button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </aside>

          <section className="template-modal__list">
            <div className="template-modal__list-head">
              <span className="template-modal__section-title">模板列表</span>
              <span className="template-modal__list-count">{activeTemplates.length} 项</span>
            </div>
            <div className="template-modal__list-items template-grid">
              <button className="template-new-card" onClick={handleNewTemplate} title="上传截图并创建新模板">
                <span className="template-new-card__icon">＋</span>
                <span className="template-new-card__text">新建模板</span>
                <span className="template-new-card__hint">上传截图并框选</span>
              </button>
              {activeTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  className={`template-grid-card delete-hover ${selectedId === tpl.id ? 'template-grid-card--active' : ''} ${selectedIds.includes(tpl.id) ? 'checked' : ''}`}
                  onClick={() => openTemplate(tpl)}
                  onMouseEnter={() => setSelectedId(tpl.id)}
                >
                  <button className="template-grid-card__check" onClick={(e) => { e.stopPropagation(); toggleSelect(tpl.id); }}>✓</button>
                  <TemplateThumb id={tpl.id} className="template-grid-card__thumb" />
                  <div className="template-grid-card__content">
                    <div className="template-grid-card__name">{tpl.name}</div>
                    <div className="template-grid-card__meta">{tpl.app ? `${tpl.app} · ` : ''}{tpl.resolution.width}×{tpl.resolution.height}{tpl.scaleFactor > 1 ? ` @${tpl.scaleFactor}x` : ''}</div>
                    <div className="template-grid-card__tags">{(tpl.tags ?? []).slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
                  </div>
                  <div className="template-grid-card__delete-controls delete-hover" onClick={(e) => e.stopPropagation()}>
                    {confirmDeleteId === tpl.id ? (
                      <>
                        <button className="delete-confirm__ok" onClick={() => handleDelete(tpl.id)}>确定</button>
                        <button className="delete-confirm__cancel" onClick={() => setConfirmDeleteId(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button className="template-grid-card__rename-btn" title="重命名模板">重命名</button>
                        <button className="delete-trigger" title="删除模板" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(tpl.id); }}>删除</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {activeTemplates.length === 0 && <div className="template-modal__empty">{templates.length === 0 ? '还没有模板，点击上方「＋ 新建模板」上传第一张截图' : '没有匹配的模板'}</div>}
            </div>
          </section>

          <aside className="template-modal__inspector">
            {apiUnavailable ? (
              <div className="template-modal__unavailable">模板库需要 Electron 主进程支持，请通过 <code>npm run dev</code> 启动后使用。</div>
            ) : edit.sourceImage ? (
              <>
                <div className="template-modal__step">1 · 预览与框选</div>
                <TemplateCropEditor
                  imageUrl={edit.sourceImage}
                  rect={edit.sourceRect}
                  offset={edit.clickOffset}
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
                <div className="template-modal__step">2 · 属性</div>
                <TemplateForm edit={edit} halfW={halfW} halfH={halfH} canSave={canSave} onChange={updateField} onSave={handleSave} folders={folders} />
              </>
            ) : edit.editing ? (
              <>
                <div className="template-modal__preview-only">
                  <TemplateThumb id={edit.editing.id} className="template-modal__big-thumb" />
                  <p>该模板没有保存来源截图，无法直接重新框选。可更换截图后重新框选，或仅修改名称与配置。</p>
                  <button className="template-modal__link" onClick={() => { pendingReplaceRef.current = true; fileInputRef.current?.click(); }}>更换截图后重新框选</button>
                </div>
                <div className="template-modal__step">2 · 属性</div>
                <TemplateForm edit={edit} halfW={halfW} halfH={halfH} canSave={Boolean(edit.name.trim())} onChange={updateField} onSave={handleSave} folders={folders} />
              </>
            ) : (
              <div className={`template-modal__upload ${dragOver ? 'template-modal__upload--drag' : ''}`} onClick={() => fileInputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}>
                <div className="template-modal__upload-icon">＋</div>
                <div className="template-modal__upload-text">拖拽截图到这里，或点击选择文件</div>
                <div className="template-modal__upload-hint">支持 PNG / JPG / WebP · 建议截取目标应用的真实画面</div>
              </div>
            )}
          </aside>
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
  folders: TemplateFolder[];
  onChange: <K extends keyof EditState>(key: K, value: EditState[K]) => void;
  onSave: () => void;
};

function TemplateForm({ edit, halfW, halfH, canSave, onChange, onSave, folders }: FormProps) {
  const clampOffset = (axis: 'x' | 'y', value: number) => {
    const bound = axis === 'x' ? halfW : halfH;
    return Math.max(-bound, Math.min(bound, Number.isFinite(value) ? value : 0));
  };

  return (
    <div className="template-form">
      <div className="template-form__grid">
        <label className="template-form__field">
          <span>名称 <span className="template-form__required">*</span></span>
          <input value={edit.name} onChange={(e) => onChange('name', e.target.value)} placeholder="如：提交按钮" />
        </label>
        <label className="template-form__field">
          目标应用
          <input value={edit.app} onChange={(e) => onChange('app', e.target.value)} placeholder="如：Chrome / Excel" />
        </label>
      </div>

      <div className="template-form__grid">
        <label className="template-form__field">
          应用内缩放
          <input value={edit.appZoom} onChange={(e) => onChange('appZoom', e.target.value)} placeholder="如：100% / 125%（手动备注）" />
        </label>
        <div className="template-form__field">
          <span>所属文件夹</span>
          <CustomSelect
            value={edit.folderId ?? ''}
            options={[{ value: '', label: '未归类' }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]}
            onChange={(v) => onChange('folderId', v || null)}
          />
        </div>
      </div>
      <div className="template-form__grid">
        <label className="template-form__field">
          系统缩放比例
          <input type="number" step="0.01" min="0.1" value={edit.scaleFactor} onChange={(e) => onChange('scaleFactor', Number(e.target.value))} />
        </label>
        <label className="template-form__field">
          窗口标题 / 备注
          <input value={edit.windowTitle} onChange={(e) => onChange('windowTitle', e.target.value)} placeholder="如：订单详情页 / 弹窗标题" />
        </label>
      </div>
      <div className="template-form__grid">
        <label className="template-form__field">
          系统分辨率
          <div className="template-form__resolution">
            <input type="number" value={edit.resolutionW} onChange={(e) => onChange('resolutionW', Number(e.target.value))} />
            <span>×</span>
            <input type="number" value={edit.resolutionH} onChange={(e) => onChange('resolutionH', Number(e.target.value))} />
          </div>
        </label>
        <div className="template-form__field">
          点击偏移（0, 0 = 匹配区域中心）
          <div className="template-form__offset">
            <input type="number" value={edit.clickOffset.x} onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, x: clampOffset('x', Number(e.target.value)) })} />
            <input type="number" value={edit.clickOffset.y} onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, y: clampOffset('y', Number(e.target.value)) })} />
            <span className="template-form__offset-hint">X {edit.clickOffset.x} / Y {edit.clickOffset.y}</span>
          </div>
        </div>
      </div>

      <label className="template-form__field">
        标签（用逗号分隔）
        <input value={edit.tags} onChange={(e) => onChange('tags', normalizeTags(e.target.value))} placeholder="登录, 首页, 按钮" />
      </label>

      <label className="template-form__field">
        其他备注
        <textarea value={edit.otherNotes} onChange={(e) => onChange('otherNotes', e.target.value)} placeholder="其他需要记录的信息…" rows={1} />
      </label>

      <div className="template-modal__footer">
        <button className="template-modal__save" onClick={onSave} disabled={!canSave || edit.saving}>
          {edit.saving ? '保存中…' : edit.editing ? '保存修改' : '保存模板'}
        </button>
        {edit.error && <span className="template-modal__error">{edit.error}</span>}
      </div>
    </div>
  );
}
