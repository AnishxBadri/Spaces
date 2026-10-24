import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
// Relative, not `@spaces/db/test-db`: vite bundles a config file with esbuild
// and externalizes every bare import, which leaves node to load a `.ts` file
// it cannot parse.
import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
} from '../../packages/db/src/test-db.ts'

const env = loadWorkspaceEnv()
const webSrc = fileURLToPath(new URL('../web/src/', import.meta.url))

export default defineConfig({
  resolve: {
    // Vitest does not read tsconfig `paths`, so its two aliases repeat here.
    // `#web/` is the worker's crossing into the web tree; `#/` is for the web
    // modules loaded through it. Regex finds, so `#web/` never matches `#/`.
    alias: [
      { find: /^#web\//, replacement: webSrc },
      { find: /^#\//, replacement: webSrc },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Tests write to `spaces_test*`, never the dev database.
    // `TEST_DATABASE_BASE_URL` repeats the value on purpose: the setup file
    // overwrites `DATABASE_URL` per file and needs a base that stays the base.
    env: {
      ...env,
      DATABASE_URL: resolveTestDatabaseUrl(env),
      TEST_DATABASE_BASE_URL: resolveTestDatabaseUrl(env),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    // Isolation is a per-file truncate of a per-worker database, so a worker
    // must own its database and environment: `forks` gives each a process, and
    // `maxWorkers` fixes how many databases `globalSetup` builds.
    pool: 'forks',
    maxWorkers: TEST_WORKERS,
    setupFiles: ['./vitest.setup.ts'],
    // Plugin bundles and the sdk's dist/ go to node, as in production: vitest
    // would resolve a bundle's imports where the loader's resolve hook never
    // runs, and inline a second copy of the sdk's port tags. A bundle is
    // `<plugins>/<id>/<version>/bundle.mjs` (the loader imports `current`'s
    // real path).
    server: {
      deps: {
        external: [
          /[\\/]plugins[\\/][^\\/]+[\\/][^\\/]+[\\/]bundle\.mjs/,
          /[\\/]packages[\\/]sdk[\\/]dist[\\/]/,
        ],
      },
    },
  },
})
