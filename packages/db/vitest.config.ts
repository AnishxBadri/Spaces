import { defineConfig } from 'vitest/config'
import {
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
  workerDatabaseUrl,
} from './src/test-db.ts'

// The db package's vitest config.
// - `.env.local` is loaded by `loadWorkspaceEnv`, anchored to a file, never
//   cwd: a cwd-relative miss loads nothing and every DB test fails on
//   ECONNREFUSED.
// - The suite writes only its own `spaces_test_db1`, never the dev database
//   and never another suite's, so its truncate cannot reach a file running
//   there. `globalSetup` builds it; `env` points the worker at it.
// - The entity-refs and downgrade-guard tests deliberately need no database:
//   they read drizzle's metadata and this package's journal folder.
const env = loadWorkspaceEnv()

// No `resolve.alias` block: this package imports nothing by alias.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: {
      ...env,
      DATABASE_URL: workerDatabaseUrl(resolveTestDatabaseUrl(env), 'db', 1),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // One worker, one database: the cheapest way to keep a truncate from
    // reaching a file running at the same moment. Larger suites pay for a
    // database per worker instead.
    fileParallelism: false,
  },
})
