import { fileURLToPath } from 'node:url'
import { config as dotenv } from 'dotenv'
import { defineConfig } from 'vitest/config'

// The first per-package vitest config (SPA-142). `.env.local` lives at the
// workspace root and this suite runs with cwd = packages/db, so the paths are
// anchored to this file rather than to cwd — a cwd-relative path here does not
// throw when it stops matching, it just loads nothing and every DB-backed test
// fails on ECONNREFUSED instead.
//
// Two of the three suites here need a database (heartbeat, and the journal
// round trip in downgrade-guard); `entity-refs.test.ts` deliberately needs
// none — it reads drizzle's own metadata out of the schema objects, so it is
// the one gate that still runs with Postgres stopped.
const envFiles = ['.env.local', '.env'].map((name) =>
  fileURLToPath(new URL(`../../${name}`, import.meta.url)),
)

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  dotenv({ path: envFiles, processEnv: out })
  return out
}

// No `resolve.alias` block: this package imports nothing by alias.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: loadEnvLocal(),
  },
})
