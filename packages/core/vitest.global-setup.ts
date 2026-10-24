import {
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * Builds the test databases: derive, create, migrate and seed the reference
 * database, then build `spaces_test_core1` for this suite's single worker.
 * - `spaces_test` is the reference database; nothing writes rows into it.
 * - The seed is imported dynamically, below `prepareTestDatabase`, because
 *   `db` builds its pool from `process.env.DATABASE_URL` at import time.
 * - The seed runs as the callback so it holds the harness advisory lock:
 *   other packages seed the same reference database in parallel.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv(), async () => {
    const { seedCoreTestDatabase } = await import('./vitest.seed.ts')
    await seedCoreTestDatabase()
  })

  const { db } = await import('@spaces/db')
  // The setup process's pool would otherwise hold the event loop open.
  // Closed before `prepareDatabase`, which moves `process.env.DATABASE_URL`
  // out from under it.
  await db.$client.end()

  await prepareDatabase(workerDatabaseUrl(url, 'core', 1))
}
