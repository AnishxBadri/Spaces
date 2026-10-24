import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Runs once before any file: migrates and seeds the reference database
 * (`spaces_test`, which the workers never use) and builds one database per
 * worker (`spaces_test_web<poolId>`).
 * - One database per worker: the per-file truncate must not reach a file
 *   running at the same moment in another worker.
 * - Every app import is dynamic and below `prepareTestDatabase`: `@spaces/db`
 *   builds its pool from `DATABASE_URL` at import time, and a static import
 *   would open it on the *dev* database.
 */
export default async function setup() {
  const env = loadWorkspaceEnv()
  // Seeded inside the harness lock: other packages seed the same reference
  // database from their own setups, and turbo runs them at once.
  const { url } = await prepareTestDatabase(env, async () => {
    const { seedTestDatabase } = await import('./vitest.seed.ts')
    await seedTestDatabase()
  })

  const { db } = await import('@spaces/db')
  // The workers open their own pools; this one belongs to the setup process
  // and would otherwise hold the event loop open after it returns. Closed
  // before the worker databases are built, because `prepareDatabase` moves
  // `process.env.DATABASE_URL` out from under it.
  await db.$client.end()

  for (let poolId = 1; poolId <= TEST_WORKERS; poolId++)
    await prepareDatabase(workerDatabaseUrl(url, 'web', poolId))
}
