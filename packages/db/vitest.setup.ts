import { db } from './src/index.ts'
import { truncatePublicTables } from './src/test-db.ts'

/**
 * Per-file isolation for the db package: empty `public` before every file.
 * - No seed: this package depends on nothing internal; its tests create
 *   every row they assert about.
 * - A static import of `db` is safe: one worker, one database, already in
 *   `DATABASE_URL` from the config before setup files run.
 */
await truncatePublicTables((text) => db.$client.query(text))
