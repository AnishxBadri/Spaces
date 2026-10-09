import { Effect, Schema } from 'effect'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { integration, spaceWatch } from '@spaces/db/schema'
import { Enqueue } from '../../queue/enqueue'
import { watchJobOf } from '../../queue/watch'
import type { WatchRunData } from '../../queue/watch'
import type { PluginQueueName } from '../../queue/names'

/**
 * The two ways a watch run is sent (D72): "Run now", from web, and the
 * cadence tick, from the worker. Both send `{ watchId, spaceId }` onto the
 * plugin's watch queue keyed by the watch id.
 * - An archived space — itself or an ancestor — pauses both.
 * - The cadence is slotted from the epoch: a watch is due once per slot of
 *   `cadence_minutes`, so a "Run now" never moves or eats the next tick.
 */

export class WatchRunRefused extends Schema.TaggedError<WatchRunRefused>()(
  'WatchRunRefused',
  { message: Schema.String },
) {}

export class WatchRunFailed extends Schema.TaggedError<WatchRunFailed>()(
  'WatchRunFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WatchRunFailed({ cause }),
  })

/** The space `spaceId` names is live: neither it nor an ancestor archived. (D73) */
export const liveSpaceOf = (spaceId: AnyPgColumn | SQL): SQL =>
  sql`not exists (
    select 1 from space s
    join space arch on arch.path @> s.path
    where s.entity_id = ${spaceId} and arch.archived_at is not null
  )`

/**
 * The integration's watches due at `now`: a cadence, a live space, and no
 * run started in the current slot. A watch with no cadence is never due.
 */
export const dueWatchesProgram = Effect.fn('dueWatchesProgram')(function* (
  integrationId: string,
  now: Date,
) {
  const at = now.toISOString()
  const slotStart = sql`to_timestamp(
    floor(extract(epoch from ${at}::timestamptz) / (${spaceWatch.cadenceMinutes} * 60))
    * (${spaceWatch.cadenceMinutes} * 60)
  )`
  const rows = yield* query(() =>
    db
      .select({ watchId: spaceWatch.id, spaceId: spaceWatch.spaceId })
      .from(spaceWatch)
      .where(
        and(
          eq(spaceWatch.integrationId, integrationId),
          isNotNull(spaceWatch.cadenceMinutes),
          liveSpaceOf(spaceWatch.spaceId),
          sql`(${spaceWatch.lastRunAt} is null or ${spaceWatch.lastRunAt} < ${slotStart})`,
        ),
      )
      .orderBy(asc(spaceWatch.createdAt), asc(spaceWatch.id)),
  )
  return rows.map((r): WatchRunData => r)
})

export type WatchRunSent =
  | {
      readonly status: 'queued'
      readonly queue: PluginQueueName
      readonly jobId: string
    }
  /**
   * pg-boss inserted nothing: a run of this watch was already waiting (it is
   * the one that runs), or the queue could not be reached.
   */
  | { readonly status: 'not-sent'; readonly queue: PluginQueueName }

/**
 * "Run now": re-read the watch, its plugin and its space, then send at once.
 * Refused — never queued — for a gone watch, a plugin that is not running or
 * has no watch job, and an archived space.
 */
export const runWatchNowProgram = Effect.fn('runWatchNowProgram')(function* (
  watchId: string,
): Effect.fn.Return<WatchRunSent, WatchRunRefused | WatchRunFailed, Enqueue> {
  const row = (yield* query(() =>
    db
      .select({
        spaceId: spaceWatch.spaceId,
        manifest: integration.manifest,
        enabled: integration.enabled,
        status: integration.status,
        capabilityId: integration.capabilityId,
        live: sql<boolean>`${liveSpaceOf(spaceWatch.spaceId)}`,
      })
      .from(spaceWatch)
      .innerJoin(integration, eq(integration.id, spaceWatch.integrationId))
      .where(eq(spaceWatch.id, watchId)),
  )).at(0)
  if (!row) return yield* new WatchRunRefused({ message: 'That watch is gone' })
  // Runnable: enabled, status `enabled`, and not a first-party `core.*` row.
  if (
    !row.enabled ||
    row.status !== 'enabled' ||
    row.capabilityId.startsWith('core.')
  )
    return yield* new WatchRunRefused({
      message: 'That plugin is not running — Today says why',
    })
  const target = watchJobOf(row.manifest)
  if (target === null)
    return yield* new WatchRunRefused({
      message: 'That plugin no longer offers a watch',
    })
  if (!row.live)
    return yield* new WatchRunRefused({
      message: 'The space is archived — restore it to run its watches',
    })
  const data: WatchRunData = { watchId, spaceId: row.spaceId }
  const jobId = yield* (yield* Enqueue).enqueue(target.queue, data, {
    singletonKey: watchId,
  })
  return jobId === null
    ? { status: 'not-sent', queue: target.queue }
    : { status: 'queued', queue: target.queue, jobId }
})
