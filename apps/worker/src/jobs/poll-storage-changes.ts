import { Effect } from 'effect'
import { z } from 'zod'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { markBindingFailedProgram } from '@spaces/core/writes/bindings/sync'
import {
  dueStorageConnectionsProgram,
  pollConnectionProgram,
} from '@spaces/core/writes/bindings/poll'
import type {
  PollConnection,
  PollOutcome,
} from '@spaces/core/writes/bindings/poll'
import type { SyncFailure } from '@spaces/core/writes/bindings/sync'
import { PluginBreaker } from './plugin-breaker'
import { StorageSources } from './storage-sources'
import { JobRetryable } from '../run-job'
import type { JobDef, JobRetryPolicy } from '../run-job'

/**
 * storage.poll — the change poll, every quarter hour: each connection with a
 * due folder binding asked once for its changes through the storage-source
 * plugin, every new file in a bound subtree filed, every held file whose
 * revision moved advanced, every renamed or moved one's path advanced and
 * every deleted one, or one moved out of every bound subtree, marked gone, by
 * core's `pollConnectionProgram`.
 * - One connection's failure is its own line: the rest are still polled.
 * - A refused token marks that connection's bindings `error` and charges the
 *   plugin, as a sync's does; a rate limit waits for the next tick.
 * - A store failure fails the run, after every connection had its turn.
 * Nullish data: pg-boss stores `null` for a schedule with no payload.
 */

export const pollStorageChangesData = z
  .object({})
  .nullish()
  .transform((v) => v ?? {})

export type PollStorageChangesData = z.infer<typeof pollStorageChangesData>

/** Never retried: the next tick is the retry, from the same cursor. */
export const pollStorageChangesRetry: JobRetryPolicy = {
  limit: 0,
  delaySeconds: 0,
  backoff: false,
}

type Polled = { readonly line: string; readonly storeFailed: boolean }

const outcomeLine = (outcome: PollOutcome): string => {
  if (outcome._tag === 'started') return 'cursor started'
  if (outcome._tag === 'relisted')
    return `cursor expired, ${String(outcome.resynced)} bindings re-synced${outcome.stored ? '' : ', cursor kept'}`
  const { tally } = outcome
  const parts = [
    `${String(tally.filed)} new`,
    `${String(tally.held)} held`,
    `${String(tally.attached)} attached by sha`,
    `${String(tally.ignored)} ignored`,
    `${String(tally.outside)} outside`,
    `${String(tally.revised)} revised`,
  ]
  if (tally.moved > 0) parts.push(`${String(tally.moved)} moved`)
  if (tally.proposed > 0)
    parts.push(`${String(tally.proposed)} moved to re-file`)
  if (tally.gone > 0) parts.push(`${String(tally.gone)} gone`)
  if (tally.skipped.length > 0)
    parts.push(
      `${String(tally.skipped.length)} skipped (${tally.skipped
        .map((s) => `${s.name}: ${s.reason}`)
        .join('; ')})`,
    )
  if (tally.refused.length > 0)
    parts.push(
      `${String(tally.refused.length)} bindings refused (${tally.refused
        .map((r) => r.reason)
        .join('; ')})`,
    )
  return parts.join(', ')
}

const pollOne = Effect.fn('pollStorageChanges.connection')(function* (
  connection: PollConnection,
) {
  const sources = yield* StorageSources
  const breaker = yield* PluginBreaker
  const said = (line: string, storeFailed = false): Polled => ({
    line: `${connection.connectionId}: ${line}`,
    storeFailed,
  })

  const opened = yield* sources
    .open({
      provider: connection.provider,
      connectionId: connection.connectionId,
    })
    .pipe(
      Effect.catchTag('StorageSourceUnavailable', () => Effect.succeed(null)),
    )
  if (opened === null) return said('no storage source to poll with')

  const markAll = (reason: string) =>
    Effect.forEach(
      connection.bindings,
      (b) => markBindingFailedProgram(b.id, reason),
      { discard: true },
    ).pipe(
      Effect.as(false),
      Effect.catchTag('BindingStoreFailed', () => Effect.succeed(true)),
    )

  const failed = (error: SyncFailure): Effect.Effect<Polled> => {
    switch (error._tag) {
      case 'RateLimited':
        return Effect.succeed(said('rate limited; the next tick retries'))
      case 'AuthExpired':
        return breaker
          .charge(opened.integrationId, `permanent: ${error.reason}`)
          .pipe(
            Effect.andThen(markAll(error.reason)),
            Effect.map((storeFailed) => said(error.reason, storeFailed)),
          )
      case 'NotFound':
      case 'CursorExpired': {
        const reason = `the provider failed mid-poll (${error._tag})`
        return breaker
          .charge(opened.integrationId, `retryable: ${reason}`)
          .pipe(Effect.as(said(reason)))
      }
      case 'DocumentBirthRejected':
        return Effect.succeed(said(error.reason))
      case 'DocumentBirthFailed':
      case 'DocumentIntakeFailed':
      case 'BindingStoreFailed':
        return Effect.succeed(said('the document store failed', true))
    }
  }

  return yield* pollConnectionProgram({
    connection,
    integrationId: opened.integrationId,
    source: opened.source,
  }).pipe(
    Effect.map((outcome): Polled => said(outcomeLine(outcome))),
    Effect.catch(failed),
  )
})

const program = Effect.fn('pollStorageChanges')(function* () {
  const due = yield* dueStorageConnectionsProgram(new Date()).pipe(
    Effect.mapError(
      () => new JobRetryable({ reason: 'binding store unavailable' }),
    ),
  )
  if (due.length === 0) return 'no binding due'
  const polled: Array<Polled> = []
  for (const connection of due)
    polled.push(yield* Effect.scoped(pollOne(connection)))
  const summary = `polled ${String(due.length)} connections: ${polled
    .map((p) => p.line)
    .join('; ')}`
  if (polled.some((p) => p.storeFailed))
    return yield* new JobRetryable({ reason: summary })
  return summary
})

export const pollStorageChanges: JobDef<
  PollStorageChangesData,
  StorageSources | Enqueue | PluginBreaker
> = {
  name: QUEUES.pollStorageChanges,
  schema: pollStorageChangesData,
  retry: pollStorageChangesRetry,
  run: () => program(),
}
