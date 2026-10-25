import {
  TEST_WORKERS,
  currentPoolId,
  truncatePublicTables,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Per-file isolation: before each test file, truncate `public` and reseed, so
 * every file starts with the seed and nothing else, with no delete list.
 * - Not transaction-per-test: the write paths open their own `db.transaction`.
 * - The base url comes from `TEST_DATABASE_BASE_URL`, not `DATABASE_URL`, which
 *   this file overwrites once per file in the same process.
 * - `DATABASE_URL` must be set before anything imports `@spaces/db` (its pool
 *   reads it at import time), hence the dynamic imports and `pool: 'forks'`.
 */

const base = process.env.TEST_DATABASE_BASE_URL
if (base === undefined || base === '')
  throw new Error(
    '[test-db] TEST_DATABASE_BASE_URL is unset — vitest.config.ts sets it alongside DATABASE_URL, and this setup file derives the worker database from it.',
  )

// `--maxWorkers=N` above TEST_WORKERS would put worker N on a database the
// global setup never built. Refusing here beats the connection error it would
// otherwise become, and beats the alternative of wrapping round, which would
// put two workers on one database and hand one of them a truncate mid-test.
const poolId = currentPoolId(process.env)
if (poolId > TEST_WORKERS)
  throw new Error(
    `[test-db] this run has at least ${poolId} workers but the global setup built ${TEST_WORKERS} databases. Raise TEST_WORKERS in packages/db/src/test-db.ts rather than passing --maxWorkers.`,
  )

process.env.DATABASE_URL = workerDatabaseUrl(base, 'web', poolId)

const { db } = await import('@spaces/db')
await truncatePublicTables((text) => db.$client.query(text))

const { seedTestDatabase } = await import('./vitest.seed.ts')

// The seeds log what they inserted, which after a truncate is everything,
// every file. Quiet for the reseed only.
const speak = console.log
console.log = () => undefined
try {
  await seedTestDatabase()
} finally {
  console.log = speak
}
