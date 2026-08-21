/// <reference types="vite/client" />

declare global {
  interface Window {
    electronAPI: Record<string, never>;
  }
}

export {};
