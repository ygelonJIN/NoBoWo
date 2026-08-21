import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClickOffset, TemplateDefinition, TemplateRect } from '@nobowo/core';
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

export function TemplateManagerModal({ onClose, onChanged }: Props) {
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>(blankEdit);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const apiUnavailable = !window.templateAPI;

  const refreshList = useCallback(async () => {
    if (!window.templateAPI) return;
    try {
      const list = await window.templateAPI.list();
      setTemplates(list);
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const readFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      setEdit((prev) => ({
        ...prev,
        editing: null,
        sourceImage: String(reader.result),
        sourceRect: null,
        clickOffset: { x: 0, y: 0 },
        name: file.name.replace(/\.[^.]+$/, '') || prev.name,
        resolutionW: window.screen?.width ?? prev.resolutionW,
        resolutionH: window.screen?.height ?? prev.resolutionH,
        scaleFactor: window.devicePixelRatio || prev.scaleFactor,
        error: null,
      }));
    };
    reader.readAsDataURL(file);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) readFile(file);
      e.target.value = '';
    },
    [readFile],
  );

  const openTemplate = useCallback(async (tpl: TemplateDefinition) => {
    setSelectedId(tpl.id);
    setConfirmDeleteId(null);
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
    setEdit(blankEdit());
  }, []);

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
        const created = await window.templateAPI.create({
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
      onChanged();
    },
    [onChanged, selectedId],
  );

  const filtered = templates.filter((t) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.app, t.notes].some((v) => v?.toLowerCase().includes(q));
  });

  const halfW = edit.sourceRect ? Math.round(edit.sourceRect.width / 2) : 0;
  const halfH = edit.sourceRect ? Math.round(edit.sourceRect.height / 2) : 0;
  const canSave = Boolean(edit.name.trim() && edit.sourceRect) && !apiUnavailable;

  const updateField = <K extends keyof EditState>(key: K, value: EditState[K]) =>
    setEdit((prev) => ({ ...prev, [key]: value }));

  return (
    <div
      className="template-modal__overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="template-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="template-modal__header">
          <div>
            <h2>模板管理</h2>
            <p>上传截图 → 框选识别区域 → 配置点击位置，供识别节点的「模板匹配」策略使用</p>
          </div>
          <button className="template-modal__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="template-modal__body">
          <aside className="template-modal__list">
            <div className="template-modal__list-actions">
              <input
                className="template-modal__search"
                placeholder="搜索模板…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className="template-modal__new" onClick={startNew}>
                + 新建
              </button>
            </div>
            <div className="template-modal__list-items">
              {filtered.map((tpl) => (
                <div
                  key={tpl.id}
                  className={`template-card ${selectedId === tpl.id ? 'template-card--active' : ''}`}
                  onClick={() => openTemplate(tpl)}
                >
                  <TemplateThumb id={tpl.id} className="template-card__thumb" />
                  <div className="template-card__info">
                    <div className="template-card__name">{tpl.name}</div>
                    <div className="template-card__meta">
                      {tpl.app ? `${tpl.app} · ` : ''}
                      {tpl.resolution.width}×{tpl.resolution.height}
                      {tpl.scaleFactor > 1 ? ` @${tpl.scaleFactor}x` : ''}
                    </div>
                  </div>
                  {confirmDeleteId === tpl.id ? (
                    <div className="template-card__confirm" onClick={(e) => e.stopPropagation()}>
                      <span>删除？</span>
                      <button onClick={() => handleDelete(tpl.id)}>确定</button>
                      <button onClick={() => setConfirmDeleteId(null)}>取消</button>
                    </div>
                  ) : (
                    <button
                      className="template-card__delete"
                      title="删除模板"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(tpl.id);
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="template-modal__empty">
                  {templates.length === 0 ? '还没有模板，点「+ 新建」上传第一张截图' : '没有匹配的模板'}
                </div>
              )}
            </div>
          </aside>

          <main className="template-modal__editor">
            {apiUnavailable ? (
              <div className="template-modal__unavailable">
                模板库需要 Electron 主进程支持，请通过 <code>npm run dev</code> 启动后使用。
              </div>
            ) : edit.sourceImage ? (
              <>
                <div className="template-modal__step">
                  <span>1 · 框选模板区域</span>
                  {edit.editing && (
                    <button
                      className="template-modal__link"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      更换截图
                    </button>
                  )}
                </div>
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
                <div className="template-modal__step">2 · 填写信息</div>
                <TemplateForm
                  edit={edit}
                  halfW={halfW}
                  halfH={halfH}
                  canSave={canSave}
                  onChange={updateField}
                  onSave={handleSave}
                />
              </>
            ) : edit.editing ? (
              <>
                <div className="template-modal__preview-only">
                  <TemplateThumb id={edit.editing.id} className="template-modal__big-thumb" />
                  <p>原始截图不可用，无法重新框选，可修改名称与配置。</p>
                  <button className="template-modal__link" onClick={() => fileInputRef.current?.click()}>
                    更换截图后重新框选
                  </button>
                </div>
                <div className="template-modal__step">2 · 填写信息</div>
                <TemplateForm
                  edit={edit}
                  halfW={halfW}
                  halfH={halfH}
                  canSave={Boolean(edit.name.trim())}
                  onChange={updateField}
                  onSave={handleSave}
                />
              </>
            ) : (
              <div
                className={`template-modal__upload ${dragOver ? 'template-modal__upload--drag' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <div className="template-modal__upload-icon">＋</div>
                <div className="template-modal__upload-text">拖拽截图到这里，或点击选择文件</div>
                <div className="template-modal__upload-hint">支持 PNG / JPG / WebP · 建议截取目标应用的真实画面</div>
              </div>
            )}
          </main>
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

function TemplateForm({ edit, halfW, halfH, canSave, onChange, onSave }: FormProps) {
  const clampOffset = (axis: 'x' | 'y', value: number) => {
    const bound = axis === 'x' ? halfW : halfH;
    return Math.max(-bound, Math.min(bound, Number.isFinite(value) ? value : 0));
  };

  return (
    <div className="template-form">
      <div className="template-form__grid">
        <label className="template-form__field">
          <span>名称 <span className="template-form__required">*</span></span>
          <input
            value={edit.name}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder="如：提交按钮"
          />
        </label>
        <label className="template-form__field">
          目标应用
          <input
            value={edit.app}
            onChange={(e) => onChange('app', e.target.value)}
            placeholder="如：Chrome / Excel"
          />
        </label>
      </div>

      <div className="template-form__grid">
        <label className="template-form__field">
          应用内缩放
          <input
            value={edit.appZoom}
            onChange={(e) => onChange('appZoom', e.target.value)}
            placeholder="如：100% / 125%（手动备注）"
          />
        </label>
        <label className="template-form__field">
          系统缩放比例
          <input
            type="number"
            step="0.01"
            min="0.1"
            value={edit.scaleFactor}
            onChange={(e) => onChange('scaleFactor', Number(e.target.value))}
          />
        </label>
      </div>
      <div className="template-form__grid">
        <label className="template-form__field">
          系统分辨率
          <div className="template-form__resolution">
            <input
              type="number"
              value={edit.resolutionW}
              onChange={(e) => onChange('resolutionW', Number(e.target.value))}
            />
            <span>×</span>
            <input
              type="number"
              value={edit.resolutionH}
              onChange={(e) => onChange('resolutionH', Number(e.target.value))}
            />
          </div>
        </label>
        <div className="template-form__field">
          点击偏移（0, 0 = 匹配区域中心）
          <div className="template-form__offset">
            <input
              type="number"
              value={edit.clickOffset.x}
              onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, x: clampOffset('x', Number(e.target.value)) })}
            />
            <input
              type="number"
              value={edit.clickOffset.y}
              onChange={(e) => onChange('clickOffset', { ...edit.clickOffset, y: clampOffset('y', Number(e.target.value)) })}
            />
            <span className="template-form__offset-hint">
              X {edit.clickOffset.x} / Y {edit.clickOffset.y}
            </span>
          </div>
        </div>
      </div>

      <label className="template-form__field">
        其他备注
        <textarea
          value={edit.otherNotes}
          onChange={(e) => onChange('otherNotes', e.target.value)}
          placeholder="其他需要记录的信息…"
          rows={1}
        />
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
