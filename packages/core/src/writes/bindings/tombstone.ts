import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, storageTombstone } from '@spaces/db/schema'

/**
 * The resurrection guard (§8, "deleted in app"): a bound document deleted
 * here leaves a `storage_tombstone` for (binding, external id), and the
 * filer never births that id for that binding again — not from the poll,
 * not from a re-list after an expired cursor.
 * - Nothing is deleted at the provider.
 * - Unlinking the binding cascades its tombstones away: a re-bind of the
 *   folder is the deliberate way back.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Tombstone the document's (binding, external id), inside the transaction
 * that deletes it. A document no binding brought writes nothing.
 */
export async function tombstoneDocument(
  tx: Tx,
  documentId: string,
): Promise<void> {
  const row = (
    await tx
      .select({
        bindingId: document.bindingId,
        externalId: document.externalId,
      })
      .from(document)
      .where(eq(document.entityId, documentId))
  ).at(0)
  if (row === undefined || row.bindingId === null || row.externalId === null)
    return
  await tx
    .insert(storageTombstone)
    .values({ bindingId: row.bindingId, externalId: row.externalId })
    .onConflictDoNothing()
}

/** Was this external id deleted in the app while this binding held it? */
export async function isTombstoned(
  bindingId: string,
  externalId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(storageTombstone)
    .where(
      and(
        eq(storageTombstone.bindingId, bindingId),
        eq(storageTombstone.externalId, externalId),
      ),
    )
    .limit(1)
  return rows.length > 0
}
