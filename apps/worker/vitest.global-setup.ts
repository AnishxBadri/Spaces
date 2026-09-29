import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * The worker's half of the SPA-143 harness, apps/web's shape (SPA-181):
 * derive the test database, create it if absent, migrate it, seed the
 * reference database, then build `spaces_test_worker1…n` — one database per
 * vitest worker, because isolation is per file (SPA-145) and the truncate
 * that buys it must not reach a file running in another worker. `spaces_test`
 * stays the reference database every package migrates and nothing writes
 * rows into; `prepareTestDatabase` holds the harness advisory lock across
 * create-and-migrate because turbo runs the four `test` tasks in parallel.
 *
 * Every import of app code is dynamic and below `prepareTestDatabase`,
 * because `@spaces/db`'s `db` builds its pool from `process.env.DATABASE_URL`
 * at import time.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv())

  const { seedTestDatabase } = await import('./vitest.seed.ts')
  await seedTestDatabase()

  const { db } = await import('@spaces/db')
  // The workers open their own pools; this one belongs to the setup process
  // and would otherwise hold the event loop open. Closed before the worker
  // databases are built, because `prepareDatabase` moves
  // `process.env.DATABASE_URL` out from under it.
  await db.$client.end()

  for (let poolId = 1; poolId <= TEST_WORKERS; poolId++)
    await prepareDatabase(workerDatabaseUrl(url, 'worker', poolId))
}
