import { useEffect, useState } from 'react';
import type { YoloModel } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';

type Props = {
  value?: string;
  onChange: (model: YoloModel) => void;
  refreshKey?: number;
};

export function ModelPicker({ value, onChange, refreshKey = 0 }: Props) {
  const [models, setModels] = useState<YoloModel[]>([]);

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

  const formatBytes = (bytes: number) => {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  };

  const options = models.length === 0
    ? [{ value: '', label: '还没有训练好的模型，请到 YOLO 训练中心训练' }]
    : models.map((model) => ({
        value: model.id,
        label: `${model.name}${model.datasetName ? ` · ${model.datasetName}` : ''}${model.metrics ? ` · mAP50 ${model.metrics.mAP50}%` : ''}${formatBytes(model.sizeBytes) ? ` · ${formatBytes(model.sizeBytes)}` : ''}`,
      }));

  return (
    <CustomSelect
      value={value ?? ''}
      options={options}
      onChange={(modelId) => {
        const model = models.find((m) => m.id === modelId);
        if (model) onChange(model);
      }}
      maxHeight={260}
    />
  );
}
