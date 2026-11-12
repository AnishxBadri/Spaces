import { Effect } from 'effect'
import { QUEUES } from '@spaces/core/queue/names'
import { embedSourceKey } from '@spaces/core/writes/ai/chunk-sources'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import { enqueue } from '#/lib/queue'

/**
 * Queues the `EmbedSource` list core's write paths hand back (`reembed` on
 * `SetValuesResult`, `ResolveResult`, `CreateRecordResult`), after the
 * commit. Outside core because the queue reads DATABASE_URL and core may not
 * read the environment.
 *
 * Never fails, like every enqueue: a failed send leaves the old chunks.
 * - Sends through `enqueue`, so a test that mocks the queue records it.
 */
export const enqueueSourceEmbedProgram = Effect.fn('enqueueSourceEmbedProgram')(
  function* (s: EmbedSource) {
    return yield* Effect.promise(() =>
      enqueue(
        QUEUES.embedSource,
        {
          entityId: s.entityId,
          sourceKind: s.sourceKind,
          sourceKey: s.sourceKey,
        },
        { singletonKey: embedSourceKey(s) },
      ),
    )
  },
)

/** `enqueueSourceEmbedProgram` for a caller that is not Effect. */
export function enqueueSourceEmbed(s: EmbedSource): Promise<string | null> {
  return Effect.runPromise(enqueueSourceEmbedProgram(s))
}
