import {
  TEST_WORKERS,
  currentPoolId,
  truncatePublicTables,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Isolation, per test file (SPA-145). Vitest runs a setup file once before
 * each test file it collects, which is the seam this needs: every file starts
 * against a database holding the seed and nothing else.
 *
 * It replaces `cleanupTestEntities`, which found rows by regex over
 * `entity.canonical_name` and hand-deleted from eleven tables in foreign-key
 * order. Anything a test wrote that was not reachable from a tagged entity
 * name — an attribute, a view, a duplicate_candidate on an untagged pair —
 * simply survived, and every new table was one more the list did not know
 * about. Truncating `public` needs no list and cannot be forgotten.
 *
 * Transaction-per-test with rollback was the other candidate and is ruled out
 * by the code: `values.ts`, `update.ts`, `resolve.ts` and `merge.ts` each open
 * their own `db.transaction`, and a naive outer transaction breaks all four.
 *
 * The base url is read from `TEST_DATABASE_BASE_URL` and not from
 * `DATABASE_URL`, which this file overwrites: it runs once per file in the
 * same process, and deriving from a value it had already rewritten would give
 * the second file `spaces_test_web1_web1`. The mutation has to happen before
 * anything imports `@spaces/db`, whose pool is built from
 * `process.env.DATABASE_URL` at import time — hence the dynamic imports
 * below, and hence `pool: 'forks'` in the config, so that this worker's
 * `process.env` is this worker's alone.
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

// The seeds say what they inserted, which is what you want on boot and
// seventy-nine lines of noise across a suite run, since after a truncate they
// insert every time. Quiet for the reseed only — the global setup still logs
// its one line per database.
const speak = console.log
console.log = () => undefined
try {
  await seedTestDatabase()
} finally {
  console.log = speak
}
