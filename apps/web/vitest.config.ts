import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
// Relative, not `@spaces/db/test-db`, and only here: vite bundles a config
// file with esbuild and externalizes every *bare* import, which leaves node
// to load a `.ts` file it cannot parse (ERR_UNKNOWN_FILE_EXTENSION). A
// relative specifier is bundled instead. `vitest.global-setup.ts` goes
// through vitest's own transform and uses the package name, as it should.
import {
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
    // Since SPA-143 the ten DB-coupled files write to `spaces_test`, never to
    // the dev database the running app is showing. `globalSetup` derives that
    // name, creates the database if absent, migrates and seeds it — including
    // the one `user` row the `select id from user limit 1` sites need — and
    // this `env` override is what points the workers at it.
    env: { ...env, DATABASE_URL: resolveTestDatabaseUrl(env) },
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
