import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

const scratchRoot = fileURLToPath(new URL('../../scratch/', import.meta.url))
const browserPathShim = fileURLToPath(new URL('./src/live2d/path-browser.ts', import.meta.url))

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      path: browserPathShim,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome100',
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    fs: {
      allow: [scratchRoot],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
})
