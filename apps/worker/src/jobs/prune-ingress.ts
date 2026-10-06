import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { pruneIngressPayloadsProgram } from '@spaces/core/writes/ingress/prune'
import { JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * ingress.prune — the nightly delete of stored webhook deliveries past
 * `INGRESS_RETENTION_DAYS`. Nullish data, because pg-boss stores `null` for
 * a schedule registered with no payload; `retentionDays` is for a test.
 */
export const pruneIngressData = z
  .object({ retentionDays: z.number().int().nonnegative().optional() })
  .nullish()
  .transform((v) => v ?? {})

export const pruneIngress: JobDef<z.infer<typeof pruneIngressData>> = {
  name: QUEUES.pruneIngress,
  schema: pruneIngressData,
  run: (data) =>
    pruneIngressPayloadsProgram(data.retentionDays).pipe(
      Effect.map(({ deleted }) => `deleted ${String(deleted)}`),
      // A delete by cutoff re-runs as a no-op, so every failure is retryable.
      Effect.catchTag(
        'IngressPruneFailed',
        (err) =>
          new JobRetryable({
            reason: `ingress prune failed: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`,
          }),
      ),
    ),
}
