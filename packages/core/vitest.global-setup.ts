import {
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from '@spaces/db/test-db'

/**
 * This package's half of the SPA-143 harness, the packages/db shape
 * (SPA-174): derive the test database, create it if it is not there, migrate
 * it, then build `spaces_test_core1`, the one database this suite's single
 * worker uses. `spaces_test` stays the reference database every package
 * migrates and nothing writes rows into.
 *
 * No seeds: `seedSystemAttributes` and the starter taxonomy are still
 * apps/web's until the boot composition moves (mono-9e), and core imports
 * nothing from apps/web. A file here that needs a system object row has to
 * insert what it asserts about.
 *
 * With Postgres down this fails once, naming the connection string, instead
 * of one ECONNREFUSED per db-coupled file — `prepareTestDatabase` holds the
 * harness advisory lock across create-and-migrate because turbo runs the
 * three `test` tasks in parallel.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv())
  await prepareDatabase(workerDatabaseUrl(url, 'core', 1))
}
