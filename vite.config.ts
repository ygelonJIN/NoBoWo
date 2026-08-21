import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(__dirname, 'packages/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@nobowo/core': resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  server: {
    port: 5173,
  },
});
