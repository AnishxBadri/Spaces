import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
// Relative, not `@spaces/db/test-db`, and only here: vite bundles a config
// file with esbuild and externalizes every *bare* import, which leaves node
// to load a `.ts` file it cannot parse (ERR_UNKNOWN_FILE_EXTENSION). A
// relative specifier is bundled instead. `vitest.global-setup.ts` goes
// through vitest's own transform and uses the package name, as it should.
import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
} from '../../packages/db/src/test-db.ts'

// `.env.local` lives at the workspace root and the suite now runs with cwd =
// apps/web, so the load is anchored to a file rather than to cwd. A
// cwd-relative path does not throw when it stops matching — dotenv just loads
// nothing and every DB-backed test fails on ECONNREFUSED instead.
// `loadWorkspaceEnv` is that load, shared with the global setup, which needs
// it too (`test.env` reaches the workers, not the setup file).
const env = loadWorkspaceEnv()

// Standalone config so vitest doesn't load the app's vite plugins
// (nitro, devtools, router codegen) just to run unit tests.
export default defineConfig({
  resolve: {
    // This block is the whole resolver for the suite — vitest does not read
    // tsconfig `paths`, so an alias that exists only there resolves for tsc
    // and vite and fails here, one `Cannot find module` per test file.
    // `@spaces/db` used to need a line here too, pointing at ./src/db while
    // the code was still in this package (SPA-135's bridge); since SPA-142 it
    // is a real workspace dependency and resolves through node_modules and
    // its own `exports` map, so `#` is all that is left.
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Since SPA-143 the DB-coupled files write to `spaces_test`, never to the
    // dev database the running app is showing. `globalSetup` derives that
    // name, creates the database if absent, migrates and seeds it — including
    // the one `user` row the `select id from user limit 1` sites need — and
    // this `env` override is what points the workers at it.
    //
    // `TEST_DATABASE_BASE_URL` carries the same value a second time on
    // purpose: `vitest.setup.ts` overwrites `DATABASE_URL` with this worker's
    // own database and runs once per *file*, so it needs a base that stays
    // the base. `DATABASE_URL` keeps pointing at `spaces_test` so a run with
    // the setup file removed still cannot reach the dev database.
    env: {
      ...env,
      DATABASE_URL: resolveTestDatabaseUrl(env),
      TEST_DATABASE_BASE_URL: resolveTestDatabaseUrl(env),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    // Isolation is per file (SPA-145) and the truncate that buys it is per
    // worker database, so a worker must own its database and its environment:
    // `forks` gives each worker its own process, and `maxWorkers` fixes how
    // many databases `globalSetup` builds. `isolate` stays on — a
    // non-isolated worker is handed every file at once and runs all the setup
    // files before any test, which would truncate twenty-four times and then
    // run twenty-four files against one database.
    pool: 'forks',
    maxWorkers: TEST_WORKERS,
    setupFiles: ['./vitest.setup.ts'],
  },
})
