import { QUEUES } from '@spaces/core/queue/names'
import { embedSourceKey } from '@spaces/core/writes/ai/chunk-sources'
import type { EmbedSource } from '@spaces/core/writes/ai/chunk-sources'
import { enqueue } from '#/lib/queue'

/**
 * The one function of `chunk-sources` that stayed behind when the rest moved
 * to @spaces/core (SPA-174/175): it reaches `lib/queue`, which reads
 * DATABASE_URL, and core may not read the environment. Core's write paths
 * hand back the `EmbedSource` list they would have queued — `reembed` on
 * `SetValuesResult`, `ResolveResult` and `CreateRecordResult` — and the
 * server fn (or job) that owns the request queues them here, after the
 * commit.
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
