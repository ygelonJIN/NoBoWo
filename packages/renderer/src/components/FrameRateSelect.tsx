import type { FrameRateSetting, LegacyFrameRateSetting, StreamFrameRate } from '@nobowo/core';
import { normalizeFrameRateSetting } from '@nobowo/core';
import { CustomSelect } from './CustomSelect';

type Props = {
  value: LegacyFrameRateSetting | undefined;
  onChange: (value: FrameRateSetting) => void;
  allowSource?: boolean;
  sourceLabel?: string;
};

export function FrameRateSelect({
  value,
  onChange,
  allowSource = true,
  sourceLabel = '跟随来源',
}: Props) {
  const normalized = normalizeFrameRateSetting(value);
  const selected = !allowSource && normalized === 'source' ? 30 : normalized;
  const options = [
    ...(allowSource ? [{ value: 'source', label: sourceLabel }] : []),
    { value: '30', label: '30 FPS' },
    { value: '60', label: '60 FPS' },
  ];

  return (
    <CustomSelect
      value={String(selected)}
      options={options}
      onChange={(next) => {
        onChange(next === 'source' ? 'source' : Number(next) as StreamFrameRate);
      }}
    />
  );
}
