import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  attributeRunMessage,
  attributeRunProgram,
} from '#web/lib/ai/attribute-run'
import type { AttributeRunInput } from '#web/lib/ai/attribute-run'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * attribute.run: one AI attribute cell, enqueued only by a cell's trigger
 * (record rail or table).
 * - Every failure is permanent: an unreachable provider, an unrouted lane, a
 *   sensitive record on a cloud route or a cell with a proposal is not fixed
 *   by a retry, and each retried model call costs.
 * - A run that finds no answer completes; the cell's status counts its rows.
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
