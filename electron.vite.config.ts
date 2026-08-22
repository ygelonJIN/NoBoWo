import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const excludeCore = { exclude: ['@nobowo/core'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(excludeCore)],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'packages/main/src/main.ts'),
      },
    },
    resolve: {
      alias: {
        '@nobowo/core': resolve(__dirname, 'packages/core/src/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(excludeCore)],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'packages/main/src/preload.ts'),
      },
    },
    resolve: {
      alias: {
        '@nobowo/core': resolve(__dirname, 'packages/core/src/index.ts'),
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
