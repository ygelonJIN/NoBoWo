export const STREAM_FRAME_RATES = [30, 60] as const;

export type StreamFrameRate = (typeof STREAM_FRAME_RATES)[number];
export type FrameRateSetting = 'source' | StreamFrameRate;
export type LegacyFrameRateSetting = FrameRateSetting | number;

export function normalizeFrameRateSetting(value: unknown): FrameRateSetting {
  if (value === 'source') return 'source';
  return value === 60 ? 60 : 30;
}

export function resolveFrameRateSetting(
  value: LegacyFrameRateSetting | undefined,
  sourceFrameRate?: StreamFrameRate,
): StreamFrameRate {
  const normalized = normalizeFrameRateSetting(value);
  if (normalized !== 'source') return normalized;
  return sourceFrameRate === 60 ? 60 : 30;
}

export function formatFrameRateSetting(value: LegacyFrameRateSetting | undefined): string {
  const normalized = normalizeFrameRateSetting(value);
  return normalized === 'source' ? '跟随来源' : `${normalized} FPS`;
}
