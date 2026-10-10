import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { rollElapsedInteractionStatsProgram } from '@spaces/core/writes/interactions/stats'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * interaction-stats.roll — every quarter hour, the entities whose next
 * meeting has started get their stats rebuilt, so it reads as last contact.
 * Nullish data: pg-boss stores `null` for a schedule with no payload.
 */
export const rollInteractionStatsData = z
  .object({})
  .nullish()
  .transform((v) => v ?? {})

export const rollInteractionStats: JobDef<
  z.infer<typeof rollInteractionStatsData>
> = {
  name: QUEUES.rollInteractionStats,
  schema: rollInteractionStatsData,
  run: () =>
    rollElapsedInteractionStatsProgram().pipe(
      Effect.map(({ rolled }) => `rolled ${String(rolled)}`),
      // A recompute re-runs as a no-op, so every failure is retryable.
      Effect.catchTag(
        'InteractionStatRollFailed',
        (err) =>
          new JobRetryable({
            reason: `interaction stats roll failed: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`,
          }),
      ),
    ),
}
