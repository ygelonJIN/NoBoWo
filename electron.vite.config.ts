import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'packages/main/src/main.ts'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'packages/main/src/preload.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'packages/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'packages/renderer/index.html'),
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@nobowo/core': resolve(__dirname, 'packages/core/src/index.ts'),
      },
    },
  },
});
