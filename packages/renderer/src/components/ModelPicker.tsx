import { useEffect, useRef, useState } from 'react';
import type { YoloModel } from '@nobowo/core';

type Props = {
  value?: string;
  onChange: (model: YoloModel) => void;
  refreshKey?: number;
};

export function ModelPicker({ value, onChange, refreshKey = 0 }: Props) {
  const [models, setModels] = useState<YoloModel[]>([]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = models.find((m) => m.id === value) ?? null;

  useEffect(() => {
    if (!window.yoloAPI) {
      setModels([]);
      return;
    }
    window.yoloAPI
      .listModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, [refreshKey]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const formatBytes = (bytes: number) => {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  };

  return (
    <div className="template-picker" ref={rootRef}>
      <button
        type="button"
        className={`template-picker__trigger ${open ? 'template-picker__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {selected ? (
          <span className="template-picker__label">
            {selected.name}
            {selected.datasetName ? ` · ${selected.datasetName}` : ''}
            {selected.isActive ? ' ★' : ''}
          </span>
        ) : value ? (
          <span className="template-picker__label template-picker__label--muted">模型已被删除</span>
        ) : (
          <span className="template-picker__label template-picker__label--muted">未选择模型</span>
        )}
        <span className="template-picker__arrow">▾</span>
      </button>
      {open && (
        <div className="template-picker__dropdown">
          {models.length === 0 ? (
            <div className="template-picker__empty">还没有训练好的模型，请到 YOLO 训练中心训练</div>
          ) : (
            models.map((model) => (
              <button
                key={model.id}
                type="button"
                className={`template-picker__option ${model.id === value ? 'template-picker__option--active' : ''}`}
                onClick={() => {
                  onChange(model);
                  setOpen(false);
                }}
              >
                <div className="template-picker__option-info">
                  <span className="template-picker__option-name">
                    {model.name}
                    {model.isActive ? ' ★' : ''}
                  </span>
                  <span className="template-picker__option-meta">
                    {model.datasetName ? `${model.datasetName} · ` : ''}
                    {model.metrics ? `mAP50 ${model.metrics.mAP50}% · ` : ''}
                    {formatBytes(model.sizeBytes)}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}