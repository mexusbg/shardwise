import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts'), playgroundWorker: resolve(__dirname, 'src/main/playground/worker.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: { ...shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
    // Readable stack traces in the field; the bundle is loaded from disk, so size barely matters.
    build: { minify: false, sourcemap: true }
  }
})
