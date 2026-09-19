import { db } from './src/index.ts'
import { truncatePublicTables } from './src/test-db.ts'

/**
 * This package's half of the per-file isolation (SPA-145): empty `public`
 * before every file.
 *
 * No seed — the two seeds are apps/web's, and this package depends on nothing
 * internal, which is the property it exists to hold. `heartbeat.test.ts` wants
 * a `worker_heartbeat` table and nothing else, and the isolation probe below
 * it creates every row it asserts about.
 *
 * No env mutation either, and so a static import of `db` is safe here: this
 * suite runs with `fileParallelism: false`, one worker against one database
 * (`spaces_test_db1`), which `vitest.config.ts` has already put in
 * `DATABASE_URL` before setup files run. Four files do not need four
 * databases; apps/web's twenty-four do.
 */
await truncatePublicTables((text) => db.$client.query(text))
