import { defineConfig } from 'vitest/config'
// Relative, not `@spaces/db/test-db`: vite bundles a config file with esbuild
// and externalizes every bare import, leaving node to load a `.ts` file it
// cannot parse. The global setup goes through vitest's transform instead.
import {
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
  workerDatabaseUrl,
} from '../db/src/test-db.ts'

// `src/writes/` tests need Postgres, so the suite loads the workspace
// `.env.local` (anchored to a file, never cwd) and runs against its own
// database, `spaces_test_core1`: turbo runs the packages' `test` tasks in
// parallel, and a truncate here must not reach another package's file.
// `globalSetup` builds it; this `env` block points the worker at it.
const env = loadWorkspaceEnv()

// No `resolve.alias` block: this package imports nothing by alias.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: {
      ...env,
      DATABASE_URL: workerDatabaseUrl(resolveTestDatabaseUrl(env), 'core', 1),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    // One worker, one database, so a truncate never reaches a file running
    // at the same moment. Enough while the db-coupled files here are few.
    fileParallelism: false,
  },
})
