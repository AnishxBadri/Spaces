import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { documentFilingRefusal } from '@spaces/core/documents/filing'
import { QUEUES } from '@spaces/core/queue/names'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import type { QueuedJob } from '@spaces/core/queue/sender'
import { connectHref } from '#/lib/connections/products'
import { enqueue, jobsByKey } from '#/lib/queue'
import { storageLinkProvider } from './storage-link'

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

    const held = (yield* query(() => listConnectionsFor(userId))).filter(
      (c) => c.provider === target.provider && c.product === target.product,
    )
    const active = held.find((c) => c.status === 'active')
    if (active === undefined) {
      const stuck = held.at(0)
      if (stuck === undefined)
        return {
          _tag: 'connect',
          href: connectHref(
            target.provider,
            target.product,
            undefined,
            input.returnTo,
          ),
          label: `Connect ${target.label}`,
        }
      return {
        _tag: 'refused',
        reason:
          stuck.errorReason ??
          `The ${target.label} connection was revoked; connect again`,
      }
    }

    const fetchId = randomUUID()
    const jobId = yield* Effect.promise(() =>
      enqueue(
        QUEUES.fetchStorageFile,
        {
          url: input.url,
          connectionId: active.id,
          attachTo: input.attachTo,
          actorUserId: userId,
        },
        { singletonKey: fetchId },
      ),
    )
    if (jobId === null)
      return {
        _tag: 'refused',
        reason: 'The worker queue is unreachable; try again',
      }
    return { _tag: 'queued', fetchId }
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
