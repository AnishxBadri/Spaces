import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  suggestSpacesMessage,
  suggestSpacesProgram,
} from '#web/lib/ai/suggest-spaces'
import type { SuggestSpacesInput } from '#web/lib/ai/suggest-spaces'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * entity.suggest-spaces: space-tag suggestions, enqueued only by the Spaces
 * rail's "Suggest spaces".
 * - Every failure is permanent: an unreachable provider, an unrouted lane or a
 *   sensitive record on a cloud route is not fixed by a retry, and each
 *   retried model call costs.
 * - A run that finds nothing completes; the rail counts the rows it wrote.
 */

export const suggestSpacesData = z.object({
  entityId: z.string().uuid(),
  userId: z.string().min(1),
})

export type SuggestSpacesData = z.infer<typeof suggestSpacesData>

/** The job's body, with the model seam the test uses. */
export const runSuggestSpaces = (
  data: SuggestSpacesData,
  seam: Pick<SuggestSpacesInput, 'model'> = {},
) =>
  suggestSpacesProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          r.skipped === null
            ? `[worker] suggest spaces ${data.entityId}: ${String(r.suggestions.length)} suggestion(s), ${String(r.dropped.length)} dropped`
            : `[worker] suggest spaces ${data.entityId} skipped: ${r.skipped}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) => new JobPermanent({ reason: suggestSpacesMessage(failure) }),
    ),
  )

export const suggestSpaces: JobDef<SuggestSpacesData> = {
  name: QUEUES.suggestSpaces,
  schema: suggestSpacesData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runSuggestSpaces(data),
}
