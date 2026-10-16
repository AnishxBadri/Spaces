import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import {
  restampStampedProgram,
  stampSensitivity,
} from '@spaces/core/writes/ai/stamp-sensitivity'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * sensitivity.restamp — chunks restamped from the live resolver, the
 * lowering half of `chunk.sensitive`. An entity still sensitive through
 * another input stays stamped.
 *
 *   - `{ entityId }`: one entity, sent after a flag is cleared, a filing
 *     removed or a binding unlinked
 *   - `{ all: true }`: every entity still stamped, sent after the workspace
 *     default goes back to normal
 *   - the entity is gone            → completed, nothing to stamp
 *   - Postgres unreachable          → JobRetryable; the stamp is one
 *     idempotent update per entity, so a retry is safe
 */

export const restampSensitivityData = z.union([
  z.object({ entityId: z.string().uuid() }),
  z.object({ all: z.literal(true) }),
])

export type RestampSensitivityData = z.infer<typeof restampSensitivityData>

const retryable = {
  SensitivityReadFailed: () =>
    Effect.fail(new JobRetryable({ reason: 'Could not resolve sensitivity' })),
  StampWriteFailed: () =>
    Effect.fail(new JobRetryable({ reason: 'Could not write the chunks' })),
}

const restampOne = (entityId: string) =>
  stampSensitivity(entityId).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] restamped ${entityId}: ${r.sensitivity}, ${String(r.stamped)} chunk(s) changed`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags({
      SensitivityEntityNotFound: () =>
        Effect.sync(() => {
          console.warn(`[worker] ${entityId} vanished before restamping`)
        }),
      ...retryable,
    }),
  )

const restampAll = () =>
  restampStampedProgram().pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] restamped ${String(r.entities)} stamped entit${r.entities === 1 ? 'y' : 'ies'}: ${String(r.stamped)} chunk(s) changed`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catchTags(retryable),
  )

export const runRestampSensitivity = (data: RestampSensitivityData) =>
  'entityId' in data ? restampOne(data.entityId) : restampAll()

export const restampSensitivity: JobDef<RestampSensitivityData> = {
  name: QUEUES.restampSensitivity,
  schema: restampSensitivityData,
  refs: (data) => ('entityId' in data ? { entityId: data.entityId } : {}),
  retry: { limit: 3, delaySeconds: 30, backoff: true },
  run: (data) => runRestampSensitivity(data),
}
