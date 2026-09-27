import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  attributeRunMessage,
  attributeRunProgram,
} from '#/lib/ai/attribute-run'
import type { AttributeRunInput } from '#/lib/ai/attribute-run'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * attribute.run — one AI attribute cell on the worker (SPA-72). The program
 * is `lib/ai/attribute-run.ts`; this is the wrapper's view of it. Enqueued
 * by a cell's trigger, on the record rail or in the table, and nothing else.
 *
 * **Every failure is permanent**, for the deck reader's reasons: an
 * unreachable provider, an unrouted lane, a sensitive record on a cloud
 * route or a cell that already has a proposal is not fixed by pg-boss
 * trying again, and each retry of a model call is a cost. A run that finds
 * no answer is not a failure: the job completes, and the cell's status
 * counts the rows it wrote.
 */

export const attributeRunData = z.object({
  entityId: z.string().uuid(),
  attributeId: z.string().uuid(),
  userId: z.string().min(1),
})

export type AttributeRunData = z.infer<typeof attributeRunData>

/** The job's body, with the model seam the test uses. */
export const runAttributeRun = (
  data: AttributeRunData,
  seam: Pick<AttributeRunInput, 'model'> = {},
) =>
  attributeRunProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.skipped === null
            ? `[worker] attribute run ${data.entityId}/${data.attributeId}: ${String(r.suggestions.length)} suggestion(s), ${String(r.proposedOptions.length)} option proposal(s)`
            : `[worker] attribute run ${data.entityId}/${data.attributeId} skipped: ${r.skipped}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: attributeRunMessage(failure) }),
    ),
  )

export const attributeRun: JobDef<AttributeRunData> = {
  name: QUEUES.attributeRun,
  schema: attributeRunData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runAttributeRun(data),
}
