import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Prepares the test databases: create, migrate and seed the reference
 * database, then build one database per vitest worker.
 * - One per worker because the per-file truncate must not reach a file running
 *   in another worker. Nothing writes rows into the reference database.
 * - The reference seed runs inside `prepareTestDatabase`'s advisory lock:
 *   turbo runs the packages' suites at once and several seed that database.
 * - App code is imported dynamically, below `prepareTestDatabase`, because
 *   `db` builds its pool from `process.env.DATABASE_URL` at import time.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv(), async () => {
    const { seedTestDatabase } = await import('./vitest.seed.ts')
    await seedTestDatabase()
  })

  const { db } = await import('@spaces/db')
  // The workers open their own pools; this one belongs to the setup process
  // and would otherwise hold the event loop open. Closed before the worker
  // databases are built, because `prepareDatabase` moves
  // `process.env.DATABASE_URL` out from under it.
  await db.$client.end()

  for (let poolId = 1; poolId <= TEST_WORKERS; poolId++)
    await prepareDatabase(workerDatabaseUrl(url, 'worker', poolId))
}
