import { db } from '@spaces/db'
import { truncatePublicTables } from '@spaces/db/test-db'
import { seedCoreTestDatabase } from './vitest.seed.ts'

/**
 * Per-file isolation: empty `public` before every file, then reseed.
 * A static `db` import is safe: one worker (`fileParallelism: false`) runs
 * against `spaces_test_core1`, already in `DATABASE_URL` before setup files.
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
