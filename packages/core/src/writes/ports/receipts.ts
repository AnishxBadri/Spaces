import { Effect, Layer } from 'effect'
import { db } from '@spaces/db'
import { enrichmentRecord } from '@spaces/db/schema'
import { JobRetryable, Receipts } from '@spaces/sdk'
import type { ReceiptClaim } from '@spaces/sdk'
import { jsonValue } from '../../json'
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
