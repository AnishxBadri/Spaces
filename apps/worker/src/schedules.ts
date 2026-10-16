import type { PgBoss } from 'pg-boss'
import { QUEUES } from '@spaces/core/queue/names'
import type { QueueName } from '@spaces/core/queue/names'

/**
 * The worker's own clock-driven jobs, scheduled at boot in UTC. Each nightly
 * scan has its own tick so they never contend on a single-worker host.
 * - No enrichment queue is ever here: nothing re-enriches on a clock; a
 *   record is enriched by a trigger or a press. (D76)
 * - The mail poll's schedule follows the mailbox row, and plugin schedules
 *   their manifests; neither is in this list.
 * - The storage change poll is a clock, not a push channel: Drive's webhooks
 *   need a public URL and expire weekly, which a box behind a router cannot
 *   promise.
 */
export const CORE_SCHEDULES: ReadonlyArray<{
  readonly queue: QueueName
  readonly cron: string
}> = [
  { queue: QUEUES.dedupeSweep, cron: '30 3 * * *' },
  { queue: QUEUES.sweepOrphanBlobs, cron: '10 4 * * *' },
  { queue: QUEUES.pruneIngress, cron: '40 4 * * *' },
  // Not nightly: a meeting that started is last contact within the quarter hour.
  { queue: QUEUES.rollInteractionStats, cron: '*/15 * * * *' },
  { queue: QUEUES.pollStorageChanges, cron: '*/15 * * * *' },
]

export const CORE_SCHEDULE_TZ = 'Etc/UTC'

/**
 * Every `CORE_SCHEDULES` entry onto its queue. Safe on every boot: pg-boss
 * keeps one schedule row per queue name and a second call replaces it.
 */
export const scheduleCoreJobs = async (boss: Pick<PgBoss, 'schedule'>) => {
  for (const { queue, cron } of CORE_SCHEDULES)
    await boss.schedule(queue, cron, undefined, { tz: CORE_SCHEDULE_TZ })
}
