import { Effect } from 'effect'
import { z } from 'zod'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { documentIntakeMessage } from '@spaces/core/writes/documents/intake'
import {
  markBindingFailedProgram,
  markBindingSyncedProgram,
  syncBindingOf,
  syncBindingProgram,
} from '@spaces/core/writes/bindings/sync'
import type { SyncTally } from '@spaces/core/writes/bindings/sync'
import { proposeUnmappedProgram } from '@spaces/core/writes/bindings/move'
import type { StorageSourceError } from '@spaces/sdk'
import { PluginBreaker } from './plugin-breaker'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * storage.sync — a binding's sync: the bound folder walked through the
 * storage-source plugin with the binder's grant, every file filed on the
 * bound record by core's `syncBindingProgram`. Sent once a bind succeeds; a
 * re-sync is the same job again, and files nothing twice.
 * - A provider failure marks the binding `error` with the provider's
 *   sentence and charges the plugin's breaker; what was filed stays.
 * - A rate limit reschedules the job and marks nothing.
 * - A folder that came close to a company and matched none exactly leaves
 *   its files on the parent and proposes each one's re-file to the closest
 *   company; a re-sync proposes nothing twice.
 */

export const syncStorageBindingData = z.object({
  bindingId: z.string().uuid(),
})

export type SyncStorageBindingData = z.infer<typeof syncStorageBindingData>

/** The sentences a binding's `error` reads when the provider gave none. */
export const SYNC_REFUSALS = {
  connectionGone: 'The connection this folder was linked with is gone',
  folderGone:
    'The linked folder is gone, or no longer shared with this account',
  notAFolder: 'Only a folder binding syncs',
} as const

const store = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  effect.pipe(
    Effect.mapError(
      () => new JobRetryable({ reason: 'binding store unavailable' }),
    ),
  )

const summaryOf = (tally: SyncTally, refiles: number): string => {
  const total = tally.filed + tally.held + tally.attached
  const parts = [
    `${String(total)} files`,
    `${String(tally.filed)} new`,
    `${String(tally.held)} held`,
    `${String(tally.attached)} attached by sha`,
  ]
  if (tally.gone > 0) parts.push(`${String(tally.gone)} gone, left untracked`)
  if (tally.skipped.length > 0)
    parts.push(
      `${String(tally.skipped.length)} skipped (${tally.skipped
        .map((s) => `${s.name}: ${s.reason}`)
        .join('; ')})`,
    )
  if (tally.unmapped.length > 0)
    parts.push(
      `${String(tally.unmapped.length)} unmapped (${tally.unmapped
        .map(
          (u) =>
            `${u.folderPath} ~ ${u.candidates.map((c) => c.name).join(' | ')}`,
        )
        .join('; ')})`,
    )
  if (refiles > 0) parts.push(`${String(refiles)} to re-file`)
  return `synced ${parts.join(', ')}`
}

const program = Effect.fn('syncStorageBinding')(function* (
  data: SyncStorageBindingData,
) {
  const binding = yield* store(syncBindingOf(data.bindingId))
  if (binding === null) return 'the binding is gone; nothing synced'
  if (binding.status === 'paused') return 'the binding is paused'

  /** The binding marked `error`, then the job's permanent failure. */
  const refuse = (reason: string) =>
    store(markBindingFailedProgram(binding.id, reason)).pipe(
      Effect.andThen(Effect.fail(new JobPermanent({ reason }))),
    )

  const { connectionId, folderId } = binding
  if (folderId === null) return yield* refuse(SYNC_REFUSALS.notAFolder)
  if (connectionId === null) return yield* refuse(SYNC_REFUSALS.connectionGone)

  const sources = yield* StorageSources
  const opened = yield* sources
    .open({ provider: binding.provider, connectionId })
    .pipe(Effect.catchTag('StorageSourceUnavailable', (e) => refuse(e.reason)))

  const breaker = yield* PluginBreaker
  /**
   * A provider failure: the plugin charged and the job failed; a refusal
   * marks the binding too. A throttle is neither.
   */
  const fromSource = (error: StorageSourceError) => {
    if (error._tag === 'RateLimited')
      return Effect.fail(
        new JobRateLimited({
          reason: 'The provider asked to slow down',
          retryAfterMs: error.retryAfterMs,
        }),
      )
    if (error._tag === 'CursorExpired') {
      const reason = 'a provider cursor expired mid-walk'
      return breaker
        .charge(opened.integrationId, `retryable: ${reason}`)
        .pipe(Effect.andThen(Effect.fail(new JobRetryable({ reason }))))
    }
    const reason =
      error._tag === 'AuthExpired' ? error.reason : SYNC_REFUSALS.folderGone
    return breaker
      .charge(opened.integrationId, `permanent: ${reason}`)
      .pipe(Effect.andThen(refuse(reason)))
  }

  const tally = yield* syncBindingProgram({
    binding,
    connectionId,
    folderId,
    integrationId: opened.integrationId,
    source: opened.source,
  }).pipe(
    Effect.catchTags({
      NotFound: fromSource,
      AuthExpired: fromSource,
      RateLimited: fromSource,
      CursorExpired: fromSource,
      DocumentBirthRejected: (e) => refuse(documentIntakeMessage(e)),
      DocumentBirthFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'could not file a document' })),
      DocumentIntakeFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'could not store a file' })),
      BindingStoreFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'document store unavailable' })),
    }),
  )
  const refiles = yield* store(
    proposeUnmappedProgram(tally.unmapped, opened.integrationId),
  )
  yield* store(markBindingSyncedProgram(binding.id))
  return summaryOf(tally, refiles)
})

export const syncStorageBinding: JobDef<
  SyncStorageBindingData,
  StorageSources | Enqueue | PluginBreaker
> = {
  name: QUEUES.syncStorageBinding,
  schema: syncStorageBindingData,
  // Retries are for a store that blinked; a rate limit reschedules itself,
  // and a re-run files nothing twice.
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) => Effect.scoped(program(data)),
}
