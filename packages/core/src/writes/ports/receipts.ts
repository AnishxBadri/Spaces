import { Effect, Layer, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { enrichmentRecord } from '@spaces/db/schema'
import { JobRetryable, Receipts } from '@spaces/sdk'
import type { ReceiptClaim } from '@spaces/sdk'
import { jsonValue } from '../../json'
import type { Tx } from '../attributes/values'
import type { BoundIntegration } from './binding'

/**
 * ReceiptsLive (sdk-7a): one `enrichment_record` per `store`, the provider's
 * payload kept whole (`raw`), `credits_used` when the job supplies it (D53
 * counts spend from these), and the bound integration in `integration_id`
 * (D57) — from the row, never from the claim. `provider` is display text,
 * written as the plugin's manifest id.
 */
export const ReceiptsLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
): Layer.Layer<Receipts> =>
  Layer.succeed(
    Receipts,
    Receipts.of({
      store: (claim: ReceiptClaim) =>
        Effect.tryPromise({
          try: async () => {
            const inserted = (
              await db
                .insert(enrichmentRecord)
                .values({
                  entityId: claim.entityId,
                  provider: row.capabilityId,
                  raw: jsonValue.parse(claim.raw),
                  creditsUsed: claim.creditsUsed ?? null,
                  integrationId: row.id,
                })
                .returning({ id: enrichmentRecord.id })
            ).at(0)
            if (!inserted)
              throw new Error('enrichment_record insert returned no row')
            return { receiptId: inserted.id }
          },
          catch: (cause) =>
            new JobRetryable({
              reason: `Receipts.store failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        }),
    }),
  )

/** The cited receipt is missing, or another integration's. */
export class ReceiptNotOwned extends Schema.TaggedError<ReceiptNotOwned>()(
  'ReceiptNotOwned',
  { receiptId: Schema.String, message: Schema.String },
) {}

/**
 * A receipt a port cites must be one **this** integration stored, checked
 * inside the citing write's transaction — otherwise a plugin could cite
 * someone else's response as its evidence. Throws `ReceiptNotOwned`.
 */
export async function checkReceipt(
  tx: Tx,
  integrationId: string,
  receiptId: string,
) {
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
