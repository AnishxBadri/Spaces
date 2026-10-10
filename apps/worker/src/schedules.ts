import { QUEUES } from '@spaces/core/queue/names'
import type { QueueName } from '@spaces/core/queue/names'

/**
 * The worker's own clock-driven jobs, scheduled at boot in UTC. Each nightly
 * scan has its own tick so the three never contend on a single-worker host.
 * - No enrichment queue is ever here: nothing re-enriches on a clock; a
 *   record is enriched by a trigger or a press. (D76)
 * - The mail poll's schedule follows the mailbox row, and plugin schedules
 *   their manifests; neither is in this list.
 */
export const CORE_SCHEDULES: ReadonlyArray<{
  readonly queue: QueueName
  readonly cron: string
}> = [
  { queue: QUEUES.dedupeSweep, cron: '30 3 * * *' },
  { queue: QUEUES.sweepOrphanBlobs, cron: '10 4 * * *' },
  { queue: QUEUES.pruneIngress, cron: '40 4 * * *' },
]
