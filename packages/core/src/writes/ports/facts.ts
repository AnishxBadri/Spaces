import { Effect, Layer, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord } from '@spaces/db/schema'
import { Facts, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { FactClaim, FillResult } from '@spaces/sdk'
import { ref } from '../../context/ref'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import {
  AttributeValidationError,
  EntityNotFound,
  setValuesInTx,
} from '../attributes/values'
import type { Tx } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import type { BoundIntegration } from './binding'

/**
 * FactsLive (sdk-9; spec-plugin-sdk §4, D52): `Facts.fill` over the one
 * attribute write path in its fill-blanks mode (`SetValuesInput.fillBlanks`),
 * so what counts as blank is decided under the entity row lock, never by a
 * read before the write.
 *
 * - **Provenance is the port's.** Every event is `actor_type 'integration'`,
 *   `actor_ref` = the bound row, `source 'enrichment'` — from the row, never
 *   from the claim, which carries no source field (D52).
 * - **The receipt is evidence.** `claim.receiptId` becomes the events'
 *   `refs` as `event:<receiptId>` — the shipped ref grammar (D4), the same
 *   spelling the context assembler cites an `enrichment_record` by. It must
 *   be a receipt **this** integration stored (checkpoint review,
 *   2026-10-01): checked inside the write's transaction, and a receipt that
 *   is missing or another integration's refuses the whole fill — otherwise
 *   a plugin could cite someone else's response as its evidence.
 * - **Conflicts are returned, not written** (D52): a value a person — or
 *   another integration — already holds is refused and handed back with the
 *   held and the proposed value; this integration's own earlier value is
 *   updated in place.
 * - **One transaction.** A value the registry refuses fails the fill
 *   permanently (retrying would send it again) and nothing of the claim is
 *   written. A merged-away record is filled on its survivor.
 *
 * Embeddable values go out through core's `Enqueue` after the commit, as
 * `IdentityLive`'s birth values do.
 */

/** The cited receipt is missing, or another integration's. */
class ReceiptNotOwned extends Schema.TaggedError<ReceiptNotOwned>()(
  'ReceiptNotOwned',
  { receiptId: Schema.String, message: Schema.String },
) {}

async function checkReceipt(tx: Tx, integrationId: string, receiptId: string) {
  const held = (
    await tx
      .select({ integrationId: enrichmentRecord.integrationId })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.id, receiptId))
  ).at(0)
  if (held?.integrationId !== integrationId)
    throw new ReceiptNotOwned({
      receiptId,
      message:
        held === undefined
          ? `no receipt ${receiptId}`
          : `receipt ${receiptId} was stored by another integration`,
    })
}

const failure = (cause: unknown) =>
  cause instanceof AttributeValidationError ||
  cause instanceof EntityNotFound ||
  cause instanceof ReceiptNotOwned
    ? new JobPermanent({ reason: `Facts.fill: ${cause.message}` })
    : new JobRetryable({
        reason: `Facts.fill failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

/** Shape check before any transaction: a malformed id is the job's bug, not a retry. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const FactsLive = (
  row: Pick<BoundIntegration, 'id'>,
): Layer.Layer<Facts, never, Enqueue> =>
  Layer.effect(
    Facts,
    Effect.gen(function* () {
      const context = yield* Effect.context<Enqueue>()

      const fill = Effect.fn('Facts.fill')(function* (claim: FactClaim) {
        const { receiptId } = claim
        if (!UUID.test(claim.entityId)) {
          return yield* new JobPermanent({
            reason: `Facts.fill: no record ${claim.entityId}`,
          })
        }
        if (receiptId !== undefined && !UUID.test(receiptId)) {
          return yield* new JobPermanent({
            reason: `Facts.fill: no receipt ${receiptId}`,
          })
        }
        const written = yield* Effect.tryPromise({
          try: () =>
            db.transaction(async (tx) => {
              if (receiptId !== undefined)
                await checkReceipt(tx, row.id, receiptId)
              return setValuesInTx(tx, {
                entityId: await canonicalId(claim.entityId, tx),
                patch: { ...claim.values },
                actor: { type: 'integration', id: row.id },
                source: 'enrichment',
                ...(receiptId === undefined
                  ? {}
                  : { refs: [ref.event(receiptId)] }),
                fillBlanks: true,
              })
            }),
          catch: failure,
        })
        yield* enqueueEmbeds(written.reembed)
        const result: FillResult = { conflicts: written.conflicts }
        return result
      })

      return Facts.of({
        fill: (claim) => fill(claim).pipe(Effect.provide(context)),
      })
    }),
  )
