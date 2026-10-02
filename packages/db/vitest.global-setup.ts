import {
  loadWorkspaceEnv,
  prepareDatabase,
  prepareTestDatabase,
  workerDatabaseUrl,
} from './src/test-db.ts'

/**
 * The db package's global setup: create and migrate the reference
 * `spaces_test` and this suite's worker database, `spaces_test_db1`.
 * - No seeds: this package depends on nothing internal, and the seeds live
 *   above it.
 * - Nothing writes rows into `spaces_test` here.
 */
export default async function setup() {
  const { url } = await prepareTestDatabase(loadWorkspaceEnv())
  await prepareDatabase(workerDatabaseUrl(url, 'db', 1))
}
