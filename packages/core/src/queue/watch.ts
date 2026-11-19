import { Schema } from 'effect'
import { decodeManifest } from '@spaces/sdk'
import { uuidString } from '../attributes/registry'
import { pluginQueueName } from './names'
import type { PluginQueueName } from './names'

/**
 * Where a watch runs: a plugin's one watch job, on its own queue, once
 * per `space_watch` row. Web's "Run now" and the worker's cadence tick both
 * send `{ watchId, spaceId }` keyed by the watch id, so the queue's `stately`
 * policy holds one run of a watch queued at a time.
 */

/** What a watch run is sent with. `spaceId` rides along for the ledger. */
export const watchRunData = Schema.Struct({
  watchId: uuidString,
  spaceId: uuidString,
})
export type WatchRunData = typeof watchRunData.Type

/** The plugin's watch job and its queue; null when it declares none. */
export const watchJobOf = (
  manifest: unknown,
): { readonly job: string; readonly queue: PluginQueueName } | null => {
  const parsed = decodeManifest(manifest)
  if (!parsed.success) return null
  const found = Object.entries(parsed.data.jobs).find(
    ([, declared]) => declared.trigger === 'watch',
  )
  if (found === undefined) return null
  const [job, declared] = found
  return {
    job,
    queue: pluginQueueName(parsed.data.id, job, declared.interactive === true),
  }
}

/** The cadence tick's queue, beside the watch job's own. */
export const watchTickQueue = (queue: PluginQueueName): PluginQueueName =>
  `${queue}.tick`

/** The cron the tick fires at: every minute, the cadence's resolution. */
export const WATCH_TICK_CRON = '* * * * *'
