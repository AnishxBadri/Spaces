import {
  TEST_WORKERS,
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * The app's half of the harness, run once before any file: build the
 * databases this suite's workers will use, and put in the reference one
 * everything the suite assumes a database already has.
 *
 * `spaces_test` is the reference database — migrated, seeded, and the one to
 * point `pnpm db:migrate:run` at to check that a run left the journal alone.
 * The workers do not use it. Each worker gets `spaces_test_web<poolId>`,
 * because since SPA-145 isolation is per *file*: `vitest.setup.ts` truncates
 * every table in `public` before each file it runs, and a truncate must not
 * be able to reach a file running at the same moment in another worker. Files
 * inside one worker are sequential, so one database per worker is exactly the
 * grain the truncate needs.
 *
 * Creating them here rather than lazily per file is what keeps the per-file
 * cost to a truncate and a reseed: `create database` and the journal check
 * happen once each, not twenty-four times.
 *
 * Every import of app code is dynamic and below `prepareTestDatabase`,
 * because `@spaces/db`'s `db` builds its pool from `process.env.DATABASE_URL`
 * at import time — a static import here would open a pool on the *dev*
 * database and seed it.
 */
export default async function setup() {
  const env = loadWorkspaceEnv()
  const { url } = await prepareTestDatabase(env)

  const { seedTestDatabase } = await import('./vitest.seed.ts')
  await seedTestDatabase()

  const { db } = await import('@spaces/db')
  // The workers open their own pools; this one belongs to the setup process
  // and would otherwise hold the event loop open after it returns. Closed
  // before the worker databases are built, because `prepareDatabase` moves
  // `process.env.DATABASE_URL` out from under it.
  await db.$client.end()

  for (let poolId = 1; poolId <= TEST_WORKERS; poolId++)
    await prepareDatabase(workerDatabaseUrl(url, 'web', poolId))
}
