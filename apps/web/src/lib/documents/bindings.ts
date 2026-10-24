import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { isBindableKind } from '@spaces/core/documents/bindings'
import { QUEUES } from '@spaces/core/queue/names'
import { hasScopes } from '@spaces/core/writes/connections/scopes'
import { listConnectionsFor } from '@spaces/core/writes/connections/list'
import {
  NOT_BINDABLE,
  RECORD_GONE,
  recordBindingsProgram,
  unlinkBindingProgram,
} from '@spaces/core/writes/bindings/bind'
import type {
  BindingOptions,
  RecordBinding,
} from '@spaces/core/writes/bindings/bind'
import { stampedSensitive } from '@spaces/core/writes/ai/stamp-sensitivity'
import { connectHref } from '#/lib/connections/products'
import { enqueueRestamp } from '#/lib/ai/enqueue-restamp'
import { enqueue, jobsByKey } from '#/lib/queue'
import { activeConnectionFor, linkFetchStatusOf } from './attach-link'
import type { LinkFetchStatus, NoConnection } from './attach-link'
import type { StorageLinkProvider } from './storage-link'

/**
 * Link a Drive folder from a record's Files tab: the checks web can make
 * (the user's own Drive connection, `drive.readonly`, a record that takes a
 * folder), then a `storage.bind-folder` job — the plugin's `getFolder` runs
 * on the worker, and the nesting guard with it.
 * - `drive.readonly` is asked for here, through the incremental-scope start
 *   route, only when the connection holds just `drive.file`.
 */

/** What a folder binding needs: Drive, and the scope that reads a whole folder. */
export const FOLDER_BINDING = {
  target: { provider: 'google', product: 'drive', label: 'Drive' },
  scopes: ['drive.readonly'],
} as const satisfies {
  readonly target: StorageLinkProvider
  readonly scopes: ReadonlyArray<string>
}

/** A folder by its pasted link, or by the id a picker answered. */
export type FolderPick = { readonly url: string } | { readonly id: string }

export type LinkFolderInput = {
  readonly folder: FolderPick
  readonly attachTo: string
  readonly options: BindingOptions
  /** Where a Connect or re-consent dance lands: the record's page. */
  readonly returnTo: string
}

export type LinkFolderOutcome =
  | { readonly _tag: 'queued'; readonly bindId: string }
  | { readonly _tag: 'consent'; readonly href: string }
  | NoConnection

export class LinkFolderFailed extends Schema.TaggedError<LinkFolderFailed>()(
  'LinkFolderFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LinkFolderFailed({ cause }),
  })

const QUEUE_UNREACHABLE = 'The worker queue is unreachable; try again'

/** Why this record cannot take a folder, or null when it can. */
const recordRefusal = Effect.fn('linkFolder.recordRefusal')(function* (
  entityId: string,
): Effect.fn.Return<string | null, LinkFolderFailed> {
  const row = (yield* query(() =>
    db
      .select({ kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, entityId)),
  )).at(0)
  if (row === undefined || row.mergedIntoId !== null) return RECORD_GONE
  return isBindableKind(row.kind) ? null : NOT_BINDABLE
})

export const linkFolderProgram = Effect.fn('linkFolderProgram')(function* (
  userId: string,
  input: LinkFolderInput,
): Effect.fn.Return<LinkFolderOutcome, LinkFolderFailed> {
  const refusal = yield* recordRefusal(input.attachTo)
  if (refusal !== null) return { _tag: 'refused', reason: refusal }

  const connection = yield* activeConnectionFor(
    userId,
    FOLDER_BINDING.target,
    input.returnTo,
  ).pipe(Effect.mapError((e) => new LinkFolderFailed({ cause: e.cause })))
  if (connection._tag !== 'active') return connection
  const connectionId = connection.connection.id

  const check = yield* hasScopes(connectionId, FOLDER_BINDING.scopes).pipe(
    Effect.mapError((cause) => new LinkFolderFailed({ cause })),
  )
  if (check._tag === 'missing')
    return {
      _tag: 'consent',
      href: connectHref(
        FOLDER_BINDING.target.provider,
        FOLDER_BINDING.target.product,
        check.scopes,
        input.returnTo,
      ),
    }

  const bindId = randomUUID()
  const jobId = yield* Effect.promise(() =>
    enqueue(
      QUEUES.bindStorageFolder,
      {
        connectionId,
        folder: input.folder,
        targetEntityId: input.attachTo,
        actorUserId: userId,
        options: input.options,
      },
      { singletonKey: bindId },
    ),
  )
  if (jobId === null) return { _tag: 'refused', reason: QUEUE_UNREACHABLE }
  return { _tag: 'queued', bindId }
})

/** Each bind by its key: fetching until the job settles, then done or its refusal. */
export const linkFolderStatusProgram = Effect.fn('linkFolderStatusProgram')(
  function* (
    bindIds: ReadonlyArray<string>,
  ): Effect.fn.Return<Record<string, LinkFetchStatus>> {
    const out: Record<string, LinkFetchStatus> = {}
    for (const id of bindIds) {
      const jobs = yield* Effect.promise(() =>
        jobsByKey(QUEUES.bindStorageFolder, id),
      )
      out[id] = linkFetchStatusOf(jobs)
    }
    return out
  },
)

/** A binding as the Files tab's band reads it: dates as ISO strings. */
export type BoundFolderRow = Omit<RecordBinding, 'lastSyncedAt'> & {
  readonly lastSyncedAt: string | null
}

export type RecordBindings = {
  readonly bindings: ReadonlyArray<BoundFolderRow>
  /** Whether Link a Drive folder is offered: a record that takes one, and the user's own active Drive. */
  readonly canLink: boolean
}

export const recordBindingsForProgram = Effect.fn('recordBindingsForProgram')(
  function* (
    userId: string,
    entityId: string,
  ): Effect.fn.Return<RecordBindings, LinkFolderFailed> {
    const rows = yield* recordBindingsProgram(entityId).pipe(
      Effect.mapError((e) => new LinkFolderFailed({ cause: e.cause })),
    )
    const refusal = yield* recordRefusal(entityId)
    const connections = yield* query(() => listConnectionsFor(userId))
    const { provider, product } = FOLDER_BINDING.target
    const drive = connections.some(
      (c) =>
        c.provider === provider &&
        c.product === product &&
        c.status === 'active',
    )
    return {
      bindings: rows.map((b) => ({
        ...b,
        lastSyncedAt:
          b.lastSyncedAt === null ? null : b.lastSyncedAt.toISOString(),
      })),
      canLink: refusal === null && drive,
    }
  },
)

/**
 * Unlink: the binding goes; the documents it filed stay. Their binding input
 * goes with it, so each one still stamped sensitive gets a
 * `sensitivity.restamp` after the unlink.
 */
export const unlinkFolderProgram = Effect.fn('unlinkFolderProgram')(function* (
  bindingId: string,
): Effect.fn.Return<boolean, LinkFolderFailed> {
  const stamped = yield* Effect.tryPromise({
    try: () => stampedSensitive(db, { kind: 'binding', bindingId }),
    catch: (cause) => new LinkFolderFailed({ cause }),
  })
  const unlinked = yield* unlinkBindingProgram(bindingId).pipe(
    Effect.mapError((e) => new LinkFolderFailed({ cause: e.cause })),
  )
  if (unlinked && stamped.length > 0)
    yield* Effect.promise(() => enqueueRestamp(stamped))
  return unlinked
})
