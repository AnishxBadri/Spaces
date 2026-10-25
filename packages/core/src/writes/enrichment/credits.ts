import { and, eq, gte, max, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord } from '@spaces/db/schema'

/**
 * The credit counter: spend is only `sum(enrichment_record.credits_used)`
 * for an integration, so it survives a restart and no second tally exists.
 */

/** Credits `integrationId`'s receipts used at or after `since`. */
export async function spendSince(
  integrationId: string,
  since: Date,
): Promise<number> {
  const row = (
    await db
      .select({
        spent: sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
          Number,
        ),
      })
      .from(enrichmentRecord)
      .where(
        and(
          eq(enrichmentRecord.integrationId, integrationId),
          gte(enrichmentRecord.fetchedAt, since),
        ),
      )
  ).at(0)
  return row?.spent ?? 0
}

/** When any source last answered for the record: its latest receipt, or null. */
export async function lastEnrichedAt(entityId: string): Promise<Date | null> {
  const row = (
    await db
      .select({ at: max(enrichmentRecord.fetchedAt) })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.entityId, entityId))
  ).at(0)
  return row?.at ?? null
}
