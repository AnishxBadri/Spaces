import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { keyTermsMessage, keyTermsProgram } from '#/lib/ai/key-terms'
import type { KeyTermsInput } from '#/lib/ai/key-terms'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.key-terms — Extract key terms on the worker (SPA-91). The
 * program is `lib/ai/key-terms.ts`; this is the wrapper's view of it, shaped
 * exactly as the deck reader's job (`./read-deck.ts`).
 *
 * **Every failure is permanent**, for the deck reader's reasons: an unrouted
 * lane, a sensitive deal routed to the cloud, a document filed on no deal,
 * a document that states no terms — none is fixed by a retry, and each
 * retry of a model call is a cost. The failure's sentence is the job's
 * output (`JobOutcome.reason`), which `keyTermsStatus` reads back for the
 * Files tab's toast.
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
