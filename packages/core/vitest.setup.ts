import { db } from '@spaces/db'
import { truncatePublicTables } from '@spaces/db/test-db'

/**
 * Per-file isolation (SPA-145), the packages/db shape: empty `public` before
 * every file. No seed, for the reason the global setup gives. A static import
 * of `db` is safe here because this suite runs `fileParallelism: false`, one
 * worker against `spaces_test_core1`, which `vitest.config.ts` has already
 * put in `DATABASE_URL` before setup files run.
 */
await truncatePublicTables((text) => db.$client.query(text))
