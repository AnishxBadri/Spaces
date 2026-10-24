import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  classifyDocumentProgram,
  classifyMessage,
} from '#web/lib/ai/classify-document'
import type { ClassifyInput } from '#web/lib/ai/classify-document'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * document.classify: kind classify, enqueued only by `onDocumentExtracted`.
 * - Every failure is permanent: an unreachable provider or unrouted lane is
 *   not fixed by a retry, and each retried model call costs.
 * - A skip (kind already set, already classified, no proposable kind)
 *   completes and says why.
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
