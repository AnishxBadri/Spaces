import {
  TEST_WORKERS,
  currentPoolId,
  truncatePublicTables,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Per-file isolation (SPA-145), apps/web's shape (SPA-181): empty `public`
 * before every file, then the seed `vitest.seed.ts` describes. The base url
 * is read from `TEST_DATABASE_BASE_URL`, not from `DATABASE_URL`, which this
 * file overwrites once per file in the same process; the mutation happens
 * before anything imports `@spaces/db`, whose pool is built from
 * `process.env.DATABASE_URL` at import time — hence the dynamic imports and
 * `pool: 'forks'` in the config.
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
