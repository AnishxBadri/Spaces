import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { objectDef } from '@spaces/db/schema'
import { truncatePublicTables } from '@spaces/db/test-db'
import { seedTestDatabase } from '../../vitest.seed'

/**
 * Per-*test* isolation for the files that need it (the arrival poll tests):
 * the harness's structural truncate-and-reseed, run again, with one thing
 * held still — the system object rows keep their ids.
 *
 * `objectIdForKind` caches the core objects' ids for the process lifetime,
 * because after seed they never change (`lib/attributes/objects.ts`). A
 * reseed that minted new ones would leave the cache pointing at rows that no
 * longer exist, and the first `resolveEntity` of the next test would fail on
 * `entity_object_id_object_id_fk` (SPA-86, which is the first slice whose
 * poll creates records). So the rows are read, the tables truncated, the
 * rows put back verbatim, and the seed then finds them by slug and reuses
 * them exactly as it does on a database that already has them.
 */
export async function truncateAndReseed(): Promise<void> {
  const systemObjects = await db
    .select()
    .from(objectDef)
    .where(eq(objectDef.isSystem, true))
  await truncatePublicTables((text) => db.$client.query(text))
  if (systemObjects.length > 0) await db.insert(objectDef).values(systemObjects)
  const speak = console.log
  console.log = () => undefined
  try {
    await seedTestDatabase()
  } finally {
    console.log = speak
  }
}
