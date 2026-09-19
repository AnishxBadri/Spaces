import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { config as dotenv } from 'dotenv'

// `.env.local` lives at the workspace root and the suite now runs with cwd =
// apps/web, so these paths are anchored to this file rather than to cwd. A
// cwd-relative path here does not throw when it stops matching — dotenv just
// loads nothing and every DB-backed test fails on ECONNREFUSED instead.
const envFiles = ['.env.local', '.env'].map((name) =>
  fileURLToPath(new URL(`../../${name}`, import.meta.url)),
)

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  dotenv({ path: envFiles, processEnv: out })
  return out
}

// Standalone config so vitest doesn't load the app's vite plugins
// (nitro, devtools, router codegen) just to run unit tests.
export default defineConfig({
  resolve: {
    // This block is the whole resolver for the suite — vitest does not read
    // tsconfig `paths`, so an alias that exists only there resolves for tsc
    // and vite and fails here, one `Cannot find module` per test file.
    // `@spaces/db` is the temporary bridge from SPA-135: the db code still
    // lives at ./src/db, the imports already name the package it becomes.
    // Both entries are prefix matches — `@spaces/db` alone hits the
    // directory's index, `@spaces/db/schema/auth` hits the file — so the two
    // lines cover all four public subpaths.
    alias: {
      '@spaces/db': fileURLToPath(new URL('./src/db', import.meta.url)),
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: loadEnvLocal(),
  },
})
