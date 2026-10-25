import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { keyTermsMessage, keyTermsProgram } from '#web/lib/ai/key-terms'
import type { KeyTermsInput } from '#web/lib/ai/key-terms'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.key-terms: Extract key terms on the worker.
 *
 * Every failure is permanent: an unrouted lane, a sensitive deal routed to
 * the cloud, a document filed on no deal or stating no terms is not fixed by
 * a retry, and each retried model call costs. The sentence is the job's
 * output (`JobOutcome.reason`), which `keyTermsStatus` reads for the toast.
 */

export const extractKeyTermsData = z.object({
  documentId: z.string().uuid(),
  userId: z.string().min(1),
})

export type ExtractKeyTermsData = z.infer<typeof extractKeyTermsData>

/** The job's body, with the model seam the test uses. */
export const runExtractKeyTerms = (
  data: ExtractKeyTermsData,
  seam: Pick<KeyTermsInput, 'model'> = {},
) =>
  keyTermsProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] key terms of ${data.documentId}: ${String(r.terms)} term(s) on ${String(r.suggestions.length)} deal(s)`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: keyTermsMessage(failure) }),
    ),
  )

export const extractKeyTerms: JobDef<ExtractKeyTermsData> = {
  name: QUEUES.extractKeyTerms,
  schema: extractKeyTermsData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runExtractKeyTerms(data),
}
