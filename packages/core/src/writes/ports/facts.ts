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
import type { Tx, ValueConflict } from '../attributes/values'
import { canonicalId } from '../entities/sweep'
import { SuggestionInvalid, proposeWith } from '../suggestions/propose'
import type { BoundIntegration } from './binding'
import { integrationPatch } from './judgment'

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
 * - **Conflicts are refused, returned, and raised** (D52; SPA-204): a value
 *   a person — or another integration — already holds is written nowhere,
 *   handed back with the held and the proposed value, and becomes one
 *   suggestion in the review inbox ("Apollo says 120, you have 85") — the
 *   Judgment lane's row (`integrationPatch`), proposed by the bound row,
 *   citing the receipt, its rationale naming the slug and both values. It
 *   is inserted in the fill's own transaction, so the fill and its
 *   suggestions commit together; a re-run raising the same conflict is a
 *   no-op insert against `suggestion_open_integration_unique`, never a read
 *   first. A conflict the inbox could not accept — a record or actor
 *   reference, which a suggestion proposes as a claim rather than an id —
 *   is returned and not raised. This integration's own earlier value is
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

/** What the reviewer reads: the slug, who says what, and what is held. */
export const conflictRationale = (
  pluginId: string,
  conflict: ValueConflict,
): string =>
  `${conflict.slug}: ${pluginId} says ${JSON.stringify(conflict.proposed)}; the record holds ${JSON.stringify(conflict.existing)}`

/**
 * One suggestion per conflict, on the fill's transaction. A refusal by the
 * proposal validator is the one outcome skipped — it throws before any SQL,
 * so the transaction is untouched; anything else rolls the fill back.
 */
async function raiseConflicts(
  tx: Tx,
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
  entityId: string,
  conflicts: ReadonlyArray<ValueConflict>,
  refs: ReadonlyArray<string>,
) {
  for (const conflict of conflicts) {
    try {
      await proposeWith(
        tx,
        integrationPatch({
          integrationId: row.id,
          entityId,
          slug: conflict.slug,
          value: conflict.proposed,
          rationale: conflictRationale(row.capabilityId, conflict),
          refs,
        }),
      )
    } catch (cause) {
      if (!(cause instanceof SuggestionInvalid)) throw cause
    }
  }
}

export const FactsLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
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
              const entityId = await canonicalId(claim.entityId, tx)
              const refs = receiptId === undefined ? [] : [ref.event(receiptId)]
              const result = await setValuesInTx(tx, {
                entityId,
                patch: { ...claim.values },
                actor: { type: 'integration', id: row.id },
                source: 'enrichment',
                ...(refs.length === 0 ? {} : { refs }),
                fillBlanks: true,
              })
              await raiseConflicts(tx, row, entityId, result.conflicts, refs)
              return result
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
