import { useEffect, useRef, useState } from 'react';
import type { TemplateDefinition } from '@nobowo/core';
import { TemplateThumb } from './TemplateThumb';

type Props = {
  templates: TemplateDefinition[];
  value?: string;
  onChange: (templateId: string) => void;
};

export function TemplatePicker({ templates, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
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

  return (
    <div className="template-picker" ref={rootRef}>
      <button
        type="button"
        className={`template-picker__trigger ${open ? 'template-picker__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
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
          {templates.length === 0 ? (
            <div className="template-picker__empty">模板库为空，请先在模板管理中创建</div>
          ) : (
            templates.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                className={`template-picker__option ${tpl.id === value ? 'template-picker__option--active' : ''}`}
                onClick={() => {
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
            ))
          )}
        </div>
      )}
    </div>
  );
}
