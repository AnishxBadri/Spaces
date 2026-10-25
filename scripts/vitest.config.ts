import path from 'node:path'
import { defineConfig } from 'vitest/config'

// The root half of the test gate (`//#test:root`): the release scripts under
// scripts/. No database. The dry-run test packs plugins/_fixtures/echo, which
// turbo builds first.
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  test: {
    include: ['scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
})
