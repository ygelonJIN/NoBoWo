import { useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateDefinition, TemplateFolder } from '@nobowo/core';
import { TemplateThumb } from './TemplateThumb';

type Props = {
  templates: TemplateDefinition[];
  folders?: TemplateFolder[];
  value?: string;
  onChange: (templateId: string) => void;
};

type FolderFilter = 'all' | 'none' | string;

export function TemplatePicker({ templates, folders = [], value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = templates.find((t) => t.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) setFolderFilter('all');
  }, [open]);

  const filtered = useMemo(() => {
    if (folderFilter === 'all') return templates;
    if (folderFilter === 'none') return templates.filter((t) => !t.folderId);
    return templates.filter((t) => t.folderId === folderFilter);
  }, [templates, folderFilter]);

  const groups = useMemo(() => {
    if (folderFilter !== 'all') return [{ label: null, items: filtered }];
    const result: { label: string | null; items: TemplateDefinition[] }[] = [];
    const noneItems = filtered.filter((t) => !t.folderId);
    if (noneItems.length > 0) result.push({ label: null, items: noneItems });
    for (const folder of folders) {
      const items = filtered.filter((t) => t.folderId === folder.id);
      if (items.length > 0) result.push({ label: folder.name, items });
    }
    return result;
  }, [filtered, folders, folderFilter]);

  const folderOptions = [
    { id: 'all' as const, label: '全部' },
    ...(templates.some((t) => !t.folderId) ? [{ id: 'none' as const, label: '未分类' }] : []),
    ...folders.map((f) => ({ id: f.id, label: f.name })),
  ];

  return (
    <div className="template-picker" ref={rootRef}>
      <button
        type="button"
        className={`template-picker__trigger ${open ? 'template-picker__trigger--open' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {selected ? (
          <>
            <TemplateThumb id={selected.id} className="template-picker__thumb" />
            <span className="template-picker__label">{selected.name}</span>
          </>
        ) : value ? (
          <span className="template-picker__label template-picker__label--muted">模板已被删除</span>
        ) : (
          <span className="template-picker__label template-picker__label--muted">未选择模板</span>
        )}
        <span className="template-picker__arrow">▾</span>
      </button>
      {open && (
        <div className="template-picker__dropdown">
          {folders.length > 0 && (
            <div className="template-picker__filter">
              {folderOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`template-picker__filter-chip ${folderFilter === option.id ? 'template-picker__filter-chip--active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFolderFilter(option.id);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {templates.length === 0 ? (
            <div className="template-picker__empty">模板库为空，请先在模板管理中创建</div>
          ) : groups.length === 0 ? (
            <div className="template-picker__empty">该文件夹下没有模板</div>
          ) : (
            groups.map((group, groupIndex) => (
              <div key={groupIndex}>
                {group.label && <div className="template-picker__group-label">{group.label}</div>}
                {group.items.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`template-picker__option ${tpl.id === value ? 'template-picker__option--active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(tpl.id);
                      setOpen(false);
                    }}
                  >
                    <TemplateThumb id={tpl.id} className="template-picker__thumb" />
                    <span className="template-picker__option-info">
                      <span className="template-picker__option-name">{tpl.name}</span>
                      <span className="template-picker__option-meta">
                        {tpl.app ? `${tpl.app} · ` : ''}
                        {tpl.resolution.width}×{tpl.resolution.height}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}