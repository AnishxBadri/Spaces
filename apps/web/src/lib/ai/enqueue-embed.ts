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
 * Never throws, like every enqueue: a failed send leaves the old chunks.
 */
export function enqueueSourceEmbed(s: EmbedSource): Promise<string | null> {
  return enqueue(
    QUEUES.embedSource,
    { entityId: s.entityId, sourceKind: s.sourceKind, sourceKey: s.sourceKey },
    { singletonKey: embedSourceKey(s) },
  )
}
