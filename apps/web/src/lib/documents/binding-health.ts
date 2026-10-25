import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { folderNameOf } from '@spaces/core/documents/bindings'
import { isProviderId } from '@spaces/core/providers/registry'
import { QUEUES } from '@spaces/core/queue/names'
import {
  accountBindingsProgram,
  failingBindingsProgram,
  waitingExportsByRecordProgram,
} from '@spaces/core/writes/bindings/health'
import type { HealthBinding } from '@spaces/core/writes/bindings/health'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import type { ConnectionListing } from '@spaces/core/writes/connections/list'
import { productOf } from '#/lib/connections/products'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'

/**
 * Binding health, web's half: a storage account page's Bound folders and
 * Exports ledgers, the re-bind window's check and commit (a worker job each,
 * polled — `getFolder` runs on the worker), and Today's failing-binding lines.
 * - A member re-binds only with their own connection; any member sees every
 *   paused or failing binding of the provider, since its binder may be gone.
 */

export class BindingHealthFailed extends Schema.TaggedError<BindingHealthFailed>()(
  'BindingHealthFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingHealthFailed({ cause }),
  })

const fromCore = <TValue, TError extends { readonly cause: unknown }>(
  effect: Effect.Effect<TValue, TError>,
) =>
  effect.pipe(
    Effect.mapError((e) => new BindingHealthFailed({ cause: e.cause })),
  )

/** The reader's connections that bring files under `provider`. */
const filesConnections = (
  rows: ReadonlyArray<ConnectionListing>,
  provider: string,
) =>
  rows.filter(
    (r) =>
      r.provider === provider &&
      isProviderId(r.provider) &&
      productOf(r.provider, r.product)?.job === 'files',
  )

/** A bound folder as the Bound folders ledger reads it: dates as ISO strings. */
export type BoundFolderHealth = Omit<HealthBinding, 'lastSyncedAt'> & {
  readonly lastSyncedAt: string | null
  /** Whether it runs on this account's own connection. */
  readonly onAccount: boolean
}

/** Uploads waiting on one record's folder. */
export type WaitingExportLine = {
  readonly targetId: string
  readonly targetName: string
  readonly count: number
  readonly since: string
}

/** One of the reader's connections a binding can move onto. */
export type RebindChoice = {
  readonly connectionId: string
  readonly email: string
  /** `Drive`, `Box`. */
  readonly label: string
  readonly status: 'active' | 'error' | 'revoked'
}

export type AccountBindings = {
  readonly bindings: ReadonlyArray<BoundFolderHealth>
  readonly exports: ReadonlyArray<WaitingExportLine>
  readonly choices: ReadonlyArray<RebindChoice>
  /** The loader's instant, so server and browser print the same ages. */
  readonly now: string
}

/**
 * A storage account page's bindings: those on the account's connections and
 * every paused or failing one of its provider, the provider's waiting
 * uploads, and the reader's connections to re-bind with. Null when the page's
 * connection is not the reader's.
 */
export const accountBindingsForProgram = Effect.fn('accountBindingsForProgram')(
  function* (
    userId: string,
    connectionId: string,
  ): Effect.fn.Return<AccountBindings | null, BindingHealthFailed> {
    const rows = yield* query(() => listConnectionsFor(userId))
    const page = rows.find((r) => r.id === connectionId)
    if (page === undefined) return null
    const held = filesConnections(rows, page.provider)
    const ids = held
      .filter((r) => r.externalEmail === page.externalEmail)
      .map((r) => r.id)
    const bindings = yield* fromCore(
      accountBindingsProgram({ provider: page.provider, connectionIds: ids }),
    )
    const exports = yield* fromCore(
      waitingExportsByRecordProgram(page.provider),
    )
    return {
      bindings: bindings.map((b) => ({
        ...b,
        lastSyncedAt:
          b.lastSyncedAt === null ? null : b.lastSyncedAt.toISOString(),
        onAccount: b.connectionId !== null && ids.includes(b.connectionId),
      })),
      exports: exports.map((e) => ({ ...e, since: e.since.toISOString() })),
      choices: held.map((r) => ({
        connectionId: r.id,
        email: r.externalEmail,
        label:
          (isProviderId(r.provider)
            ? productOf(r.provider, r.product)?.name
            : undefined) ?? r.product,
        status: r.status,
      })),
      now: new Date().toISOString(),
    }
  },
)

export type RebindInput = {
  readonly bindingId: string
  readonly connectionId: string
  /** False: only the folder check. True: the check, then the re-bind. */
  readonly commit: boolean
}

export type RebindQueued =
  | { readonly _tag: 'queued'; readonly checkId: string }
  | { readonly _tag: 'refused'; readonly reason: string }

const QUEUE_UNREACHABLE = 'The worker queue is unreachable; try again'

/** Sends the check (or the re-bind) as the reader, with one of their own connections. */
export const rebindFolderProgram = Effect.fn('rebindFolderProgram')(function* (
  userId: string,
  input: RebindInput,
): Effect.fn.Return<RebindQueued, BindingHealthFailed> {
  const rows = yield* query(() => listConnectionsFor(userId))
  if (!rows.some((r) => r.id === input.connectionId))
    return { _tag: 'refused', reason: 'Not your connection' }
  const checkId = randomUUID()
  const jobId = yield* Effect.promise(() =>
    enqueue(
      QUEUES.rebindStorageFolder,
      { ...input, actorUserId: userId },
      { singletonKey: checkId },
    ),
  )
  if (jobId === null) return { _tag: 'refused', reason: QUEUE_UNREACHABLE }
  return { _tag: 'queued', checkId }
})

export type RebindStatus =
  | { readonly state: 'checking' }
  | { readonly state: 'passed'; readonly line: string }
  | { readonly state: 'refused'; readonly reason: string }

const reasonOf = (output: object | null): string | null => {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** One check by its jobs: the passed line, the refusal, or still checking. */
export function rebindStatusOf(
  jobs: ReadonlyArray<QueuedJob> | null,
): RebindStatus {
  const latest = [...(jobs ?? [])]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'checking' }
  if (latest.state === 'completed')
    return { state: 'passed', line: reasonOf(latest.output) ?? 'ok' }
  if (latest.state === 'failed' || latest.state === 'cancelled')
    return {
      state: 'refused',
      reason: reasonOf(latest.output) ?? 'The folder could not be checked',
    }
  return { state: 'checking' }
}

export const rebindStatusProgram = Effect.fn('rebindStatusProgram')(function* (
  checkIds: ReadonlyArray<string>,
): Effect.fn.Return<Record<string, RebindStatus>> {
  const out: Record<string, RebindStatus> = {}
  for (const id of checkIds) {
    const jobs = yield* Effect.promise(() =>
      jobsByKey(QUEUES.rebindStorageFolder, id),
    )
    out[id] = rebindStatusOf(jobs)
  }
  return out
})

/** One binding in `error`, as Today's notices band prints it. */
export type FailingBinding = {
  readonly bindingId: string
  /** `Vayu — Legal`. */
  readonly title: string
  readonly error: string | null
  /** The reader's account page that lists it; null sends them to Files. */
  readonly fixConnectionId: string | null
}

/**
 * Every failing binding, each pointed at the reader's own account page for
 * its provider: the binding's own connection when it is the reader's, else
 * their first, else none.
 */
export const failingBindingsForProgram = Effect.fn('failingBindingsForProgram')(
  function* (
    userId: string,
  ): Effect.fn.Return<ReadonlyArray<FailingBinding>, BindingHealthFailed> {
    const failing = yield* fromCore(failingBindingsProgram())
    if (failing.length === 0) return []
    const rows = yield* query(() => listConnectionsFor(userId))
    return failing.map((b) => {
      const held = filesConnections(rows, b.provider)
      const own = held.find((r) => r.id === b.connectionId) ?? held.at(0)
      return {
        bindingId: b.id,
        title: `${b.targetName} — ${folderNameOf(b.folderPath)}`,
        error: b.error,
        fixConnectionId: own?.id ?? null,
      }
    })
  },
)
