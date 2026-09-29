import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { summarizeMessage, summarizeProgram } from '#web/lib/ai/summarize'
import type { SummarizeInput } from '#web/lib/ai/summarize'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * entity.summarize — Summarize on the worker (SPA-66). The program is
 * `lib/ai/summarize.ts`; this is the wrapper's view of it, shaped exactly as
 * the deck reader's job (`./read-deck.ts`).
 *
 * **Every failure is permanent**, for the deck reader's reasons: nothing a
 * retry thirty seconds later would fix — an unrouted lane, a sensitive
 * record routed to the cloud, nothing to summarize — and every retry of a
 * frontier call is a cost. The failure's sentence is the job's output
 * (`JobOutcome.reason`), which `summarizeStatus` reads back for the toast.
 */

export const summarizeData = z.object({
  recordId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  userId: z.string().min(1),
})

export type SummarizeData = z.infer<typeof summarizeData>

/** The job's body, with the model seam the test uses. */
export const runSummarize = (
  data: SummarizeData,
  seam: Pick<SummarizeInput, 'model'> = {},
) =>
  summarizeProgram({ ...data, ...seam }).pipe(
    Effect.tap((s) =>
      Effect.sync(() => {
        console.log(
          `[worker] summarized ${data.documentId ?? data.recordId} onto ${data.recordId}: suggestion ${s.id}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: summarizeMessage(failure) }),
    ),
  )

export const summarize: JobDef<SummarizeData> = {
  name: QUEUES.summarize,
  schema: summarizeData,
  refs: (data) => ({ entityId: data.documentId ?? data.recordId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runSummarize(data),
}
