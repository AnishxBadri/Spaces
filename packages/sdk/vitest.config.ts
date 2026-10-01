import { defineConfig } from 'vitest/config'

// No harness, no env, no database: the SDK is the package a plugin author
// tests with Postgres stopped, and its own suite holds itself to that. No
// globalSetup, so `turbo run test --filter=@spaces/sdk` answers with the
// database down — unlike db, core, web and worker.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
