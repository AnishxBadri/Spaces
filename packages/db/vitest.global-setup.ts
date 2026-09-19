import {
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from './src/test-db.ts'

/**
 * This package's half of the SPA-143 harness: derive the test database,
 * create it if it is not there, migrate it. No seeds — `heartbeat.test.ts`
 * wants a `worker_heartbeat` table and nothing else, and the two seeds are
 * apps/web's (this package depends on nothing internal, and that is the
 * property it exists to hold).
 *
 * Since SPA-145 it builds one more: `spaces_test_db1`, the database this
 * suite's single worker actually uses. `spaces_test` stays the reference
 * database both packages migrate — it is what `pnpm db:migrate:run` should be
 * pointed at — and nothing writes rows into it here.
 *
 * Both packages' setups call the same `prepareTestDatabase`, which holds a
 * Postgres advisory lock across create-and-migrate, because turbo runs the
 * two `test` tasks in parallel.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv())
  await prepareDatabase(workerDatabaseUrl(url, 'db', 1))
}
