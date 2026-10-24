import {
  TEST_WORKERS,
  currentPoolId,
  truncatePublicTables,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Per-file isolation: empty `public` before every file, then reseed.
 * - The base url comes from `TEST_DATABASE_BASE_URL`, because this file
 *   overwrites `DATABASE_URL` once per file in the same process.
 * - That overwrite must happen before anything imports `@spaces/db`, whose
 *   pool reads `DATABASE_URL` at import time; hence the dynamic imports.
 */

const base = process.env.TEST_DATABASE_BASE_URL
if (base === undefined || base === '')
  throw new Error(
    '[test-db] TEST_DATABASE_BASE_URL is unset — vitest.config.ts sets it alongside DATABASE_URL, and this setup file derives the worker database from it.',
  )

const poolId = currentPoolId(process.env)
if (poolId > TEST_WORKERS)
  throw new Error(
    `[test-db] this run has at least ${poolId} workers but the global setup built ${TEST_WORKERS} databases. Raise TEST_WORKERS in packages/db/src/test-db.ts rather than passing --maxWorkers.`,
  )

process.env.DATABASE_URL = workerDatabaseUrl(base, 'worker', poolId)

const { db } = await import('@spaces/db')
await truncatePublicTables((text) => db.$client.query(text))

const { seedTestDatabase } = await import('./vitest.seed.ts')

// Quiet for the reseed only — the global setup still logs its one line per
// database.
const speak = console.log
console.log = () => undefined
try {
  await seedTestDatabase()
} finally {
  console.log = speak
}
