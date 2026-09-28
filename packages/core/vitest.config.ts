import { defineConfig } from 'vitest/config'
// Relative, not `@spaces/db/test-db`, for the reason apps/web's config gives:
// vite bundles a config file with esbuild and externalizes every *bare*
// import, which leaves node to load a `.ts` file it cannot parse. The global
// setup goes through vitest's own transform and uses the package name.
import {
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
  workerDatabaseUrl,
} from '../db/src/test-db.ts'

// Until SPA-174 this config loaded no env on purpose: mono-7's contract was
// that every module in @spaces/core computes, so the suite had to pass with
// DATABASE_URL unset. That contract is per-directory now — `src/writes/` is
// the db-coupled half and its tests need Postgres, like packages/db's — so
// the suite takes the SPA-143/145 harness: the workspace `.env.local`
// (anchored to a file, never cwd), a test database derived from
// DATABASE_URL, and one database of its own, `spaces_test_core1`, because
// turbo runs the three `test` tasks in parallel and a truncate between files
// here must not reach a file running in apps/web's or packages/db's worker.
// `globalSetup` builds it; this `env` block is what points the worker at it.
// The purity test still runs with no connection — it reads source text.
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
    // One worker, one database — packages/db's answer to "a truncate must not
    // reach a file running at the same moment", and the right one while the
    // db-coupled files here are few.
    fileParallelism: false,
  },
})
