import { Effect } from 'effect'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import { embedSourceKey } from './chunk-sources'
import type { EmbedSource } from './chunk-sources'

/**
 * `enqueueSourceEmbed` as an Effect over core's `Enqueue` service: the same
 * job and singleton key, for a write port that cannot reach apps/web's
 * `enqueueSourceEmbed` (which reads `DATABASE_URL`).
 */
export const enqueueEmbeds = (sources: ReadonlyArray<EmbedSource>) =>
  Effect.gen(function* () {
    const queue = yield* Enqueue
    for (const s of sources) {
      yield* queue.enqueue(
        QUEUES.embedSource,
        {
          entityId: s.entityId,
          sourceKind: s.sourceKind,
          sourceKey: s.sourceKey,
        },
        { singletonKey: embedSourceKey(s) },
      )
    }
  })
