import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  classifyDocumentProgram,
  classifyMessage,
} from '#/lib/ai/classify-document'
import type { ClassifyInput } from '#/lib/ai/classify-document'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.classify — kind classify on the worker (SPA-62). The program is
 * `lib/ai/classify-document.ts`; this is the wrapper's view of it. Enqueued
 * by `onDocumentExtracted` and by nothing else.
 *
 * **Every failure is permanent**, for the deck reader's reasons: an
 * unreachable provider or an unrouted lane is not fixed by pg-boss trying
 * again in thirty seconds, and each retry of a model call is a cost. A skip
 * (the kind already set, a classification already made, an answer with no
 * proposable kind) is not a failure: the job completes and says why.
 */

export const classifyDocumentData = z.object({
  documentId: z.string().uuid(),
})

export type ClassifyDocumentData = z.infer<typeof classifyDocumentData>

/** The job's body, with the model seam the test uses. */
export const runClassifyDocument = (
  data: ClassifyDocumentData,
  seam: Pick<ClassifyInput, 'model'> = {},
) =>
  classifyDocumentProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.status === 'proposed'
            ? `[worker] classified ${data.documentId}: suggestion ${r.suggestion.id}`
            : `[worker] classify ${data.documentId} skipped: ${r.reason}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: classifyMessage(failure) }),
    ),
  )

export const classifyDocument: JobDef<ClassifyDocumentData> = {
  name: QUEUES.classifyDocument,
  schema: classifyDocumentData,
  refs: (data) => ({ entityId: data.documentId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runClassifyDocument(data),
}
