import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { documentFilingRefusal } from '@spaces/core/documents/filing'
import { QUEUES } from '@spaces/core/queue/names'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import type { ConnectionListing } from '@spaces/core/writes/connections/list'
import { canonicalFileUrl } from '@spaces/core/writes/connections/sources'
import type { ProviderId } from '@spaces/core/providers/registry'
import type { QueuedJob } from '@spaces/core/queue/sender'
import { connectHref } from '#/lib/connections/products'
import { enqueue, jobsByKey } from '#/lib/queue'
import { storageLinkProvider } from './storage-link'
import type { StorageLinkProvider } from './storage-link'

/**
 * Attach from a link: a pasted storage-source URL becomes a fetch job on the
 * worker, which is where the plugin resolves it (web imports no plugin code).
 * - The pasting user's own connection for the provider's product fetches it
 *   (D66); none offers Connect, one in error says why.
 * - The answer is immediate; the fetch is polled by its `fetchId`, which is
 *   the job's `singletonKey`.
 */

export type AttachFromLinkInput = {
  readonly url: string
  readonly attachTo: string
  /** Where a Connect dance lands afterwards: the record's own page. */
  readonly returnTo: string
}

export type AttachFromLinkOutcome =
  | { readonly _tag: 'queued'; readonly fetchId: string }
  | { readonly _tag: 'connect'; readonly href: string; readonly label: string }
  | { readonly _tag: 'refused'; readonly reason: string }

/** Not a storage link at all, or not a record to file on. */
export class LinkNotAttachable extends Schema.TaggedError<LinkNotAttachable>()(
  'LinkNotAttachable',
  { reason: Schema.String },
) {}

export class AttachLinkFailed extends Schema.TaggedError<AttachLinkFailed>()(
  'AttachLinkFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence a caller shows; a `Schema.TaggedError` carries none. */
export function attachLinkMessage(failure: unknown): string {
  if (failure instanceof LinkNotAttachable) return failure.reason
  return 'Could not attach this link'
}

export const NOT_FETCHABLE = 'Not a link we can fetch'

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AttachLinkFailed({ cause }),
  })

const checkRecord = Effect.fn('attachFromLink.checkRecord')(function* (
  entityId: string,
): Effect.fn.Return<void, LinkNotAttachable | AttachLinkFailed> {
  const row = (yield* query(() =>
    db
      .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, entityId)),
  )).at(0)
  if (row === undefined || row.mergedIntoId !== null)
    return yield* new LinkNotAttachable({
      reason: 'That record no longer exists.',
    })
  const refusal = documentFilingRefusal({ kind: 'record', entityId }, row.kind)
  if (refusal !== null) return yield* new LinkNotAttachable({ reason: refusal })
})

export const attachFromLinkProgram = Effect.fn('attachFromLinkProgram')(
  function* (
    userId: string,
    input: AttachFromLinkInput,
  ): Effect.fn.Return<
    AttachFromLinkOutcome,
    LinkNotAttachable | AttachLinkFailed
  > {
    const target = storageLinkProvider(input.url)
    if (target === null)
      return yield* new LinkNotAttachable({ reason: NOT_FETCHABLE })
    yield* checkRecord(input.attachTo)

    const connection = yield* activeConnectionFor(
      userId,
      target,
      input.returnTo,
    )
    if (connection._tag !== 'active') return connection

    const fetchId = yield* enqueueFetch({
      url: input.url,
      connectionId: connection.connection.id,
      attachTo: input.attachTo,
      actorUserId: userId,
    })
    if (fetchId === null) return { _tag: 'refused', reason: QUEUE_UNREACHABLE }
    return { _tag: 'queued', fetchId }
  },
)

/** What a storage action says when the user cannot use the product yet. */
export type NoConnection = Exclude<
  AttachFromLinkOutcome,
  { readonly _tag: 'queued' }
>

/**
 * The user's own active connection for the product (D66), or what to say
 * instead: none held offers Connect back to `returnTo`, one in error says
 * the provider's reason.
 */
export const activeConnectionFor = Effect.fn('activeConnectionFor')(function* (
  userId: string,
  target: StorageLinkProvider,
  returnTo: string,
): Effect.fn.Return<
  | { readonly _tag: 'active'; readonly connection: ConnectionListing }
  | NoConnection,
  AttachLinkFailed
> {
  const held = (yield* query(() => listConnectionsFor(userId))).filter(
    (c) => c.provider === target.provider && c.product === target.product,
  )
  const active = held.find((c) => c.status === 'active')
  if (active !== undefined) return { _tag: 'active', connection: active }
  const stuck = held.at(0)
  if (stuck === undefined)
    return {
      _tag: 'connect',
      href: connectHref(target.provider, target.product, undefined, returnTo),
      label: `Connect ${target.label}`,
    }
  return {
    _tag: 'refused',
    reason:
      stuck.errorReason ??
      `The ${target.label} connection was revoked; connect again`,
  }
})

const QUEUE_UNREACHABLE = 'The worker queue is unreachable; try again'

/** One `document.fetch-storage`, keyed for the poll; null when the queue refused it. */
const enqueueFetch = Effect.fn('enqueueFetch')(function* (data: {
  readonly url: string
  readonly connectionId: string
  readonly attachTo: string
  readonly actorUserId: string
}): Effect.fn.Return<string | null> {
  const fetchId = randomUUID()
  const jobId = yield* Effect.promise(() =>
    enqueue(QUEUES.fetchStorageFile, data, { singletonKey: fetchId }),
  )
  return jobId === null ? null : fetchId
})

export type PickedFile = { readonly id: string; readonly name: string }

export type AttachFromPickerInput = {
  readonly provider: ProviderId
  readonly attachTo: string
  readonly files: ReadonlyArray<PickedFile>
  readonly returnTo: string
}

/** One fetch per picked file; `fetchId` null when the queue refused that one. */
export type AttachFromPickerOutcome =
  | {
      readonly _tag: 'queued'
      readonly files: ReadonlyArray<
        PickedFile & { readonly fetchId: string | null }
      >
    }
  | NoConnection

/**
 * Files picked in the provider's picker: one `document.fetch-storage` per
 * file, on the provider's own link for it, exactly as a pasted link goes.
 * - A file picked twice in one pick is fetched once.
 * - A file the connection already holds is filed, never downloaded again:
 *   the job's (`connection_id`, `external_id`) check.
 */
export const attachFromPickerProgram = Effect.fn('attachFromPickerProgram')(
  function* (
    userId: string,
    input: AttachFromPickerInput,
  ): Effect.fn.Return<
    AttachFromPickerOutcome,
    LinkNotAttachable | AttachLinkFailed
  > {
    const files = [
      ...new Map(
        input.files.map((f): [string, PickedFile] => [f.id, f]),
      ).values(),
    ]
    const links: Array<{ file: PickedFile; url: string }> = []
    for (const file of files) {
      const url = canonicalFileUrl(input.provider, file.id)
      if (url === null)
        return yield* new LinkNotAttachable({ reason: NOT_FETCHABLE })
      links.push({ file, url })
    }
    // The provider's own link names its product: drive.google.com is Drive.
    const target = storageLinkProvider(links.at(0)?.url ?? '')
    if (target === null)
      return yield* new LinkNotAttachable({ reason: NOT_FETCHABLE })
    yield* checkRecord(input.attachTo)

    const connection = yield* activeConnectionFor(
      userId,
      target,
      input.returnTo,
    )
    if (connection._tag !== 'active') return connection

    const queued: Array<PickedFile & { readonly fetchId: string | null }> = []
    for (const { file, url } of links) {
      const fetchId = yield* enqueueFetch({
        url,
        connectionId: connection.connection.id,
        attachTo: input.attachTo,
        actorUserId: userId,
      })
      queued.push({ id: file.id, name: file.name, fetchId })
    }
    return { _tag: 'queued', files: queued }
  },
)

export type LinkFetchStatus =
  | { readonly state: 'fetching' }
  | { readonly state: 'done' }
  | { readonly state: 'failed'; readonly reason: string }

/** The wrapper's `JobOutcome.reason`, read off a settled job's output. */
const reasonOf = (output: object | null): string | null => {
  if (output === null) return null
  const reason: unknown = Reflect.get(output, 'reason')
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** One fetch, by its jobs: queued, running or retrying is still fetching. */
export function linkFetchStatusOf(
  jobs: ReadonlyArray<QueuedJob> | null,
): LinkFetchStatus {
  const latest = [...(jobs ?? [])]
    .sort((a, b) => b.createdOn.getTime() - a.createdOn.getTime())
    .at(0)
  if (latest === undefined) return { state: 'fetching' }
  if (latest.state === 'completed') return { state: 'done' }
  if (latest.state === 'failed' || latest.state === 'cancelled')
    return {
      state: 'failed',
      reason: reasonOf(latest.output) ?? 'The file could not be fetched',
    }
  return { state: 'fetching' }
}

export const linkFetchStatusProgram = Effect.fn('linkFetchStatusProgram')(
  function* (
    fetchIds: ReadonlyArray<string>,
  ): Effect.fn.Return<Record<string, LinkFetchStatus>> {
    const out: Record<string, LinkFetchStatus> = {}
    for (const id of fetchIds) {
      const jobs = yield* Effect.promise(() =>
        jobsByKey(QUEUES.fetchStorageFile, id),
      )
      out[id] = linkFetchStatusOf(jobs)
    }
    return out
  },
)
