import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { activity } from '@spaces/db/schema/activity'
import { holding } from '@spaces/db/schema/portfolio'

/** `db` or an open transaction — the verbs a holding birth uses. */
export type HoldingExecutor = Pick<typeof db, 'select' | 'insert'>

/**
 * The pipeline→portfolio seam: a deal reaching Invested births a holding.
 * Idempotent — one holding per company, follow-ons land on the existing row.
 * - Outside the server modules: deal birth's transaction and the import
 *   worker call it without a request context (the server's shared module
 *   re-exports it).
 * - `on` is `db` by default, or the caller's transaction when the holding
 *   must land or fail with the deal that births it.
 */
export async function birthHolding(
  opts: {
    companyId: string
    actorId: string
    openedAt?: string | undefined
  },
  on: HoldingExecutor = db,
): Promise<{ id: string; created: boolean }> {
  const openedAt = opts.openedAt ?? new Date().toISOString().slice(0, 10)
  const inserted = await on
    .insert(holding)
    .values({ companyId: opts.companyId, openedAt, createdBy: opts.actorId })
    .onConflictDoNothing()
    .returning({ id: holding.id })
  const born = inserted.at(0)
  if (born) {
    await on.insert(activity).values({
      actorId: opts.actorId,
      verb: 'holding.created',
      subjectEntityId: opts.companyId,
    })
    return { id: born.id, created: true }
  }
  const existing = (
    await on
      .select({ id: holding.id })
      .from(holding)
      .where(eq(holding.companyId, opts.companyId))
  ).at(0)
  if (!existing) throw new Error('Holding vanished during its birth')
  return { id: existing.id, created: false }
}
