import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
// Relative, not `@spaces/db/test-db`, for the reason apps/web's config gives:
// vite bundles a config file with esbuild and externalizes every bare import,
// which leaves node to load a `.ts` file it cannot parse.
import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  resolveTestDatabaseUrl,
} from '../../packages/db/src/test-db.ts'

const env = loadWorkspaceEnv()
const webSrc = fileURLToPath(new URL('../web/src/', import.meta.url))

export default defineConfig({
  resolve: {
    // Vitest does not read tsconfig `paths`, so the two aliases tsconfig.json
    // declares are declared again here (SPA-181). `#web/` is the worker's own
    // crossing into the web tree; `#/` is for the web modules loaded through
    // it, which import each other as `#/lib/…`. Regex finds, so `#web/` is
    // never mistaken for a `#/` prefix. Both go when lib/ has moved into core.
    alias: [
      { find: /^#web\//, replacement: webSrc },
      { find: /^#\//, replacement: webSrc },
    ],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Since SPA-143 the DB-coupled files write to `spaces_test*`, never to
    // the dev database. `TEST_DATABASE_BASE_URL` carries the same value a
    // second time on purpose: `vitest.setup.ts` overwrites `DATABASE_URL`
    // with this worker's own database once per file and needs a base that
    // stays the base.
    env: {
      ...env,
      DATABASE_URL: resolveTestDatabaseUrl(env),
      TEST_DATABASE_BASE_URL: resolveTestDatabaseUrl(env),
    },
    globalSetup: ['./vitest.global-setup.ts'],
    // Isolation is per file (SPA-145) and the truncate that buys it is per
    // worker database, so a worker must own its database and its environment:
    // `forks` gives each its own process, and `maxWorkers` fixes how many
    // databases `globalSetup` builds — `spaces_test_worker1…4`.
    pool: 'forks',
    maxWorkers: TEST_WORKERS,
    setupFiles: ['./vitest.setup.ts'],
    // The plugin loader (sdk-11) imports bundles with node's own `import()`
    // and a `node:module` resolve hook, as it does in production. Vitest's
    // runner would otherwise transform a bundle itself and resolve its bare
    // imports with vite's resolver, where the hook never runs; and it would
    // inline the sdk's dist/ (a workspace link, not node_modules), giving the
    // test a second copy of the tags the hook resolves plugins to. Both are
    // handed to node, so the test sees exactly what the worker does.
    server: {
      deps: {
        external: [
          /[\\/]plugins[\\/][^\\/]+[\\/]current[\\/]/,
          /[\\/]packages[\\/]sdk[\\/]dist[\\/]/,
        ],
      },
    },
  },
})
