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

// `.env.local` lives at the workspace root, so the load is anchored to a file,
// not cwd: a cwd-relative path that misses loads nothing silently. Shared with
// the global setup, which `test.env` does not reach.
const env = loadWorkspaceEnv()

// Standalone config so vitest doesn't load the app's vite plugins
// (nitro, devtools, router codegen) just to run unit tests.
export default defineConfig({
  resolve: {
    // The whole resolver for the suite: vitest does not read tsconfig `paths`,
    // so an alias that exists only there fails here, one `Cannot find module`
    // per test file.
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // `.tsx` for tests that render through `renderToStaticMarkup`. The
    // environment stays `node`: no DOM, no test-renderer.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Points the workers at the test database, never the dev one.
    // - `TEST_DATABASE_BASE_URL` repeats the value on purpose: the setup
    //   file overwrites `DATABASE_URL` per file and needs a stable base.
    // - `DATABASE_URL` points at `spaces_test`, so a run without the setup file
    //   still cannot reach the dev database.
    env: {
      ...env,
      DATABASE_URL: resolveTestDatabaseUrl(env),
      TEST_DATABASE_BASE_URL: resolveTestDatabaseUrl(env),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    // Each worker owns its database and its environment: `forks` gives it its
    // own process, and `maxWorkers` fixes how many databases `globalSetup`
    // builds. `isolate` stays on: a non-isolated worker runs every setup file
    // before any test, so all files would share one truncate.
    pool: 'forks',
    maxWorkers: TEST_WORKERS,
    // 15s, not vitest's 5s: most DB-backed files import their modules inside
    // the first test, which then pays for a cold transform of effect, drizzle
    // and the module graph, and on CI that crosses 5s. A real hang still
    // fails.
    testTimeout: 15_000,
    setupFiles: ['./vitest.setup.ts'],
  },
})
