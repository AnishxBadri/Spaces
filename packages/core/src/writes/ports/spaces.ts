import { Effect, Layer } from 'effect'
import { JobPermanent, JobRetryable, Spaces } from '@spaces/sdk'
import { spaceBriefProgram } from '../context/space-brief'
import type { BoundIntegration } from './binding'
import { actorOf } from './read'

/**
 * SpacesLive: a watch's subject, read as the bound integration.
 * - `brief(spaceId)` is `spaceBriefProgram` with the row as the reader —
 *   no argument names a reader, so a plugin cannot read as anyone else.
 * - A refusal (missing, archived, sensitive) is `JobPermanent` naming why, so
 *   the run closes failed with the reason in `job_run.error`; a query that
 *   failed is `JobRetryable`.
 */
export const SpacesLive = (
  row: Pick<BoundIntegration, 'id'>,
): Layer.Layer<Spaces> => {
  const reader = actorOf(row)
  return Layer.succeed(
    Spaces,
    Spaces.of({
      brief: (spaceId) =>
        spaceBriefProgram(spaceId, reader).pipe(
          Effect.catchTags({
            SpaceBriefRefused: (e) =>
              Effect.fail(
                new JobPermanent({ reason: `Spaces.brief: ${e.reason}` }),
              ),
            ContextLeak: (e) =>
              Effect.fail(
                new JobPermanent({ reason: `Spaces.brief: ${e.message}` }),
              ),
            ContextQueryFailed: (e) =>
              Effect.fail(
                new JobRetryable({
                  reason: `Spaces.brief failed: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`,
                }),
              ),
          }),
        ),
    }),
  )
}
