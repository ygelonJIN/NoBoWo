import { useSyncExternalStore } from 'react';

export type Ps5ViewerMode = 'embedded' | 'expanded' | 'pip' | 'hidden';

let viewerMode: Ps5ViewerMode = 'embedded';
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getPs5ViewerMode(): Ps5ViewerMode {
  return viewerMode;
}

export function setPs5ViewerMode(mode: Ps5ViewerMode) {
  if (viewerMode === mode) return;
  viewerMode = mode;
  emit();
}

export function usePs5ViewerMode(): Ps5ViewerMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPs5ViewerMode,
    getPs5ViewerMode,
  );
}
