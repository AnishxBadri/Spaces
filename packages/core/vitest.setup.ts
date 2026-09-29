import { db } from '@spaces/db'
import { truncatePublicTables } from '@spaces/db/test-db'
import { seedCoreTestDatabase } from './vitest.seed.ts'

/**
 * Per-file isolation (SPA-145), the packages/db shape: empty `public` before
 * every file, then the seed `vitest.seed.ts` describes. A static import of
 * `db` is safe here because this suite runs `fileParallelism: false`, one
 * worker against `spaces_test_core1`, which `vitest.config.ts` has already
 * put in `DATABASE_URL` before setup files run.
 */
await truncatePublicTables((text) => db.$client.query(text))

// The seed says what it inserted, which after a truncate is every time.
// Quiet for the reseed only — the global setup still logs its line.
const speak = console.log
console.log = () => undefined
try {
  await seedCoreTestDatabase()
} finally {
  console.log = speak
}
