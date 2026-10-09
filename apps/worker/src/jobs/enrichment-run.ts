import { Effect } from 'effect'
import type { Layer } from 'effect'
import { z } from 'zod'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { runEnrichment } from '@spaces/core/writes/enrichment/run'
import type { EnrichmentSources } from '@spaces/core/enrichment/sources'
import { enqueue } from '#web/lib/queue'
import type { JobDef } from '../run-job'

/**
 * enrichment.run — one record enriched from the owner's sources in order
 * (D76). The summary is the run's timeline line in short, or why nothing
 * was asked.
 */

export const enrichmentRunData = z.object({
  entityId: z.uuid(),
  reason: z.string().min(1).max(100),
})

export type EnrichmentRunData = z.infer<typeof enrichmentRunData>

/** The embeds a run hands back, through the worker's sender. */
export const enrichmentEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})

export const enrichmentRun: JobDef<
  EnrichmentRunData,
  EnrichmentSources | Enqueue
> = {
  name: QUEUES.enrichmentRun,
  schema: enrichmentRunData,
  refs: (data) => ({ entityId: data.entityId }),
  retry: { limit: 2, delaySeconds: 60, backoff: true },
  run: (data) =>
    runEnrichment(data.entityId, data.reason).pipe(
      Effect.map((outcome) =>
        outcome.ran
          ? `${String(outcome.fields)} field(s), ${String(outcome.credits)} credit(s)`
          : `nothing asked: ${outcome.reason}`,
      ),
    ),
}
