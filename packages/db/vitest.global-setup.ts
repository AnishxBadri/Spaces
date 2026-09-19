import { loadWorkspaceEnv, prepareTestDatabase } from './src/test-db.ts'

/**
 * This package's half of the SPA-143 harness: derive the test database,
 * create it if it is not there, migrate it. No seeds — `heartbeat.test.ts`
 * wants a `worker_heartbeat` table and nothing else, and the two seeds are
 * apps/web's (this package depends on nothing internal, and that is the
 * property it exists to hold).
 *
 * Both packages' setups call the same `prepareTestDatabase`, which holds a
 * Postgres advisory lock across create-and-migrate, because turbo runs the
 * two `test` tasks in parallel.
 */
export default async function setup() {
  await prepareTestDatabase(loadWorkspaceEnv())
}
