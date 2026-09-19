import { defineConfig } from 'vitest/config'
import { loadWorkspaceEnv, resolveTestDatabaseUrl } from './src/test-db.ts'

// The first per-package vitest config (SPA-142). `.env.local` lives at the
// workspace root and this suite runs with cwd = packages/db, so the load is
// anchored to a file rather than to cwd — a cwd-relative path here does not
// throw when it stops matching, it just loads nothing and every DB-backed
// test fails on ECONNREFUSED instead. `loadWorkspaceEnv` is that load,
// shared with the global setup, which needs it too (`test.env` reaches the
// workers, not the setup file).
//
// Since SPA-143 the suite talks to `spaces_test`, never to the dev database:
// `globalSetup` derives it, creates it if absent and migrates it, and this
// `env` block is what points the workers at it. Two of the three files here
// need it (heartbeat, and the journal round trip in downgrade-guard);
// `entity-refs.test.ts` deliberately needs no database at all — it reads
// drizzle's own metadata out of the schema objects, so it is the one gate
// that still answers with Postgres stopped.
const env = loadWorkspaceEnv()

// No `resolve.alias` block: this package imports nothing by alias.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { ...env, DATABASE_URL: resolveTestDatabaseUrl(env) },
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
