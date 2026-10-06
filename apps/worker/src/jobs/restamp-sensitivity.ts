import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { stampSensitivity } from '@spaces/core/writes/ai/stamp-sensitivity'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * sensitivity.restamp — one entity's chunks restamped from the live
 * resolver, the lowering half of `chunk.sensitive`. Sent after a flag is
 * cleared or a filing removed; an entity still sensitive through another
 * input stays stamped.
 *
 *   - the entity is gone            → completed, nothing to stamp
 *   - Postgres unreachable          → JobRetryable; the stamp is one
 *     idempotent update, so a retry is safe
 */

export const restampSensitivityData = z.object({
  entityId: z.string().uuid(),
})

export type RestampSensitivityData = z.infer<typeof restampSensitivityData>

export const runRestampSensitivity = (data: RestampSensitivityData) =>
  stampSensitivity(data.entityId).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] restamped ${data.entityId}: ${r.sensitivity}, ${String(r.stamped)} chunk(s) changed`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags({
      SensitivityEntityNotFound: () =>
        Effect.sync(() => {
          console.warn(`[worker] ${data.entityId} vanished before restamping`)
        }),
      SensitivityReadFailed: () =>
        Effect.fail(
          new JobRetryable({ reason: 'Could not resolve sensitivity' }),
        ),
      StampWriteFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'Could not write the chunks' })),
    }),
  )

export const restampSensitivity: JobDef<RestampSensitivityData> = {
  name: QUEUES.restampSensitivity,
  schema: restampSensitivityData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  run: (data) => runRestampSensitivity(data),
}
