import { defineConfig } from 'vitest/config'
import {
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
  workerDatabaseUrl,
} from './src/test-db.ts'

// The first per-package vitest config (SPA-142). `.env.local` lives at the
// workspace root and this suite runs with cwd = packages/db, so the load is
// anchored to a file rather than to cwd — a cwd-relative path here does not
// throw when it stops matching, it just loads nothing and every DB-backed
// test fails on ECONNREFUSED instead. `loadWorkspaceEnv` is that load,
// shared with the global setup, which needs it too (`test.env` reaches the
// workers, not the setup file).
//
// Since SPA-143 the suite talks to a test database, never to the dev one, and
// since SPA-145 that database is this suite's own: `spaces_test_db1`, not the
// `spaces_test` both packages migrate and not one of apps/web's four worker
// databases, because turbo runs the two `test` tasks in parallel and a
// truncate between files here must not be able to reach a file running there.
// `globalSetup` builds it; this `env` block is what points the worker at it.
// Two of the files here need a database (heartbeat and the isolation probe);
// `entity-refs.test.ts` and `downgrade-guard.test.ts` deliberately need none —
// they read drizzle's own metadata and this package's journal folder.
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
    // Four files, one worker, one database — the cheapest answer to "a
    // truncate must not reach a file running at the same moment". apps/web
    // has twenty-four files and cannot afford to serialise them, so it pays
    // for a database per worker instead; here that would be three databases
    // to save half a second.
    fileParallelism: false,
  },
})
