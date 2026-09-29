import {
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * This package's half of the SPA-143 harness, the packages/db shape
 * (SPA-174): derive the test database, create it if it is not there, migrate
 * it, seed the reference database, then build `spaces_test_core1`, the one
 * database this suite's single worker uses. `spaces_test` stays the reference
 * database every package migrates and nothing writes rows into.
 *
 * The seed is `vitest.seed.ts` — system attributes and the fixture user, not
 * the starter taxonomy, which is still apps/web's until the boot composition
 * moves (mono-9e). It is imported dynamically and below `prepareTestDatabase`
 * because `@spaces/db`'s `db` builds its pool from `process.env.DATABASE_URL`
 * at import time.
 *
 * With Postgres down this fails once, naming the connection string, instead
 * of one ECONNREFUSED per db-coupled file — `prepareTestDatabase` holds the
 * harness advisory lock across create-and-migrate because turbo runs the
 * three `test` tasks in parallel.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv())

  const { seedCoreTestDatabase } = await import('./vitest.seed.ts')
  await seedCoreTestDatabase()

  const { db } = await import('@spaces/db')
  // The worker opens its own pool; this one belongs to the setup process and
  // would otherwise hold the event loop open. Closed before the worker
  // database is built, because `prepareDatabase` moves
  // `process.env.DATABASE_URL` out from under it.
  await db.$client.end()

  await prepareDatabase(workerDatabaseUrl(url, 'core', 1))
}
