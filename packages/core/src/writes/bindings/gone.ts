import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document } from '@spaces/db/schema'
import { BindingStoreFailed } from './bind'

/**
 * A pointer that stopped being one: deleted at the provider, or moved out of
 * every bound subtree (§8, "deleted in Drive"; the move out is decided the
 * same way).
 * - Ours is kept: the row, its blob, chunks, edges and `binding_id` stay, so
 *   it still previews and searches from our copy. Nothing is deleted at the
 *   provider, and nothing is proposed — there is no new home to offer.
 * - One way only: no write path sets a `gone` row back to `linked`. Every
 *   held-file write (`claimHeld`, `stampAttached`, `moveHeldProgram`,
 *   `reviseDocumentProgram`, `keepTokenProgram`) carries `goneNot`.
 */

/** The predicate every held-file write carries: a gone row is never touched. */
export const goneNot = sql`${document.externalStatus} is distinct from 'gone'`

/**
 * Mark the document held for (connection, external id) gone. True when a row
 * changed; false when none is held or it was already gone.
 */
export const markGoneProgram = Effect.fn('markGoneProgram')(function* (
  connectionId: string,
  externalId: string,
): Effect.fn.Return<boolean, BindingStoreFailed> {
  const marked = yield* Effect.tryPromise({
    try: () =>
      db
        .update(document)
        .set({ externalStatus: 'gone' })
        .where(
          and(
            eq(document.connectionId, connectionId),
            eq(document.externalId, externalId),
            goneNot,
          ),
        )
        .returning({ id: document.entityId }),
    catch: (cause) => new BindingStoreFailed({ cause }),
  })
  return marked.length > 0
})
