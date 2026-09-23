import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { readDeckMessage, readDeckProgram } from '#/lib/ai/read-deck'
import type { ReadDeckInput } from '#/lib/ai/read-deck'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.read-deck — the deck reader on the worker (SPA-90). The program
 * is `lib/ai/read-deck.ts`; this is the wrapper's view of it.
 *
 * **Every failure is permanent.** A provider that is unreachable, a lane that
 * is not routed, a sensitive record routed to the cloud: none is fixed by
 * pg-boss trying again in thirty seconds, and each retry of a model call is a
 * cost. The failure's sentence is the job's output (`JobOutcome.reason`),
 * which `readDeckStatus` reads back for the Files tab's toast — no column on
 * `document` is borrowed for it; `extraction_error` is extraction's.
 */

export const readDeckData = z.object({
  documentId: z.string().uuid(),
  userId: z.string().min(1),
})

export type ReadDeckData = z.infer<typeof readDeckData>

/** The job's body, with the model seam the test uses. */
export const runReadDeck = (
  data: ReadDeckData,
  seam: Pick<ReadDeckInput, 'model'> = {},
) =>
  readDeckProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] read deck ${data.documentId}: ${String(r.suggestions.length)} suggestion(s), ${String(r.skipped.length)} skipped`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: readDeckMessage(failure) }),
    ),
  )

export const readDeck: JobDef<ReadDeckData> = {
  name: QUEUES.readDeck,
  schema: readDeckData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runReadDeck(data),
}
