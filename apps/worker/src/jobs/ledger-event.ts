import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  ledgerEventMessage,
  proposeLedgerEventProgram,
} from '#web/lib/ai/ledger-event'
import type { LedgerEventInput } from '#web/lib/ai/ledger-event'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.ledger-event — a revised cap table read against its company's
 * holding, on the worker. The program is `proposeLedgerEventProgram`;
 * enqueued by `onDocumentExtracted` and by nothing else.
 * - Every failure is permanent: a retried model call costs, and an
 *   unrouted lane is not fixed by waiting.
 * - A skip (a newer revision, a proposal already made, nothing moved) is
 *   not a failure: the job completes and says why.
 */

export const ledgerEventData = z.object({
  documentId: z.string().uuid(),
  revisionId: z.string().min(1),
})

export type LedgerEventData = z.infer<typeof ledgerEventData>

/** The job's body, with the model seam the test uses. */
export const runLedgerEvent = (
  data: LedgerEventData,
  seam: Pick<LedgerEventInput, 'model'> = {},
) =>
  proposeLedgerEventProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.status === 'proposed'
            ? `[worker] ledger event for ${data.documentId}: suggestion ${r.suggestion.id}`
            : `[worker] ledger event for ${data.documentId} skipped: ${r.reason}`,
        )
      }),
    ),
    Effect.catch(
      (failure) => new JobPermanent({ reason: ledgerEventMessage(failure) }),
    ),
  )

export const proposeLedgerEvent: JobDef<LedgerEventData> = {
  name: QUEUES.proposeLedgerEvent,
  schema: ledgerEventData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runLedgerEvent(data).pipe(Effect.asVoid),
}
