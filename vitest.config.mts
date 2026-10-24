import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 180000
  }
})
