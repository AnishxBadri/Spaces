import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindFolderProgram } from '@spaces/core/writes/bindings/bind'
import type { StorageSourceError } from '@spaces/sdk'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobFailure } from '../run-job'

/**
 * storage.bind-folder — Link a Drive folder: the folder (a pasted link, or
 * an id from the picker) is read through the storage-source plugin with the
 * binding user's grant, and its ancestry from `getFolder` is what the
 * nesting guard of `bindFolderProgram` tests. A bound folder's first sync
 * is sent from here (`storage.sync`, keyed by the binding).
 * - A connection with no change cursor gets one read before the bind and
 *   stored with it, so a file added while the first sync walks is the first
 *   poll's.
 * - Every refusal is a `JobPermanent` whose reason the bind dialog shows.
 */

export const bindStorageFolderData = z.object({
  connectionId: z.string().uuid(),
  folder: z.union([
    z.object({ url: z.string().url() }),
    z.object({ id: z.string().min(1).max(200) }),
  ]),
  targetEntityId: z.string().uuid(),
  actorUserId: z.string().min(1),
  options: z.object({
    mapSubfolders: z.boolean(),
    retain: z.enum(['full', 'text']),
    direction: z.enum(['pull', 'push', 'both']),
    sensitivity: z.enum(['inherit', 'sensitive']),
  }),
})

export type BindStorageFolderData = z.infer<typeof bindStorageFolderData>

/** The sentences a refusal reads as in the dialog. */
export const BIND_REFUSALS = {
  notAFolder: 'That link does not point at a folder',
  notFound: 'The folder is not one your account can read',
  connectionGone: 'The connection this folder was linked with is gone',
} as const

const store = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new JobRetryable({ reason: 'binding store unavailable' }),
  })

const fromSource = (error: StorageSourceError): JobFailure => {
  switch (error._tag) {
    case 'NotFound':
      return new JobPermanent({ reason: BIND_REFUSALS.notFound })
    case 'AuthExpired':
      return new JobPermanent({ reason: error.reason })
    case 'RateLimited':
      return new JobRateLimited({
        reason: 'The provider asked to slow down',
        retryAfterMs: error.retryAfterMs,
      })
    case 'CursorExpired':
      return new JobRetryable({ reason: 'a provider cursor expired' })
  }
}

const program = Effect.fn('bindStorageFolder')(function* (
  data: BindStorageFolderData,
) {
  const connection = (yield* store(() =>
    db
      .select({
        provider: accountConnection.provider,
        cursor: accountConnection.storageCursor,
      })
      .from(accountConnection)
      .where(
        and(
          eq(accountConnection.id, data.connectionId),
          eq(accountConnection.userId, data.actorUserId),
        ),
      ),
  )).at(0)
  if (connection === undefined)
    return yield* new JobPermanent({ reason: BIND_REFUSALS.connectionGone })

  const sources = yield* StorageSources
  const { source } = yield* sources
    .open({ provider: connection.provider, connectionId: data.connectionId })
    .pipe(Effect.mapError((e) => new JobPermanent({ reason: e.reason })))

  let folderId: string
  if ('url' in data.folder) {
    const target = yield* source
      .resolveLink(data.folder.url)
      .pipe(Effect.mapError(fromSource))
    if (target === null || !('folderId' in target))
      return yield* new JobPermanent({ reason: BIND_REFUSALS.notAFolder })
    folderId = target.folderId
  } else folderId = data.folder.id

  const folder = yield* source
    .getFolder(folderId)
    .pipe(Effect.mapError(fromSource))
  const path = [...folder.parents.map((p) => p.name), folder.name].join(' / ')
  const start =
    connection.cursor === null
      ? yield* source.changes(null).pipe(Effect.mapError(fromSource))
      : null

  const bound = yield* bindFolderProgram({
    connectionId: data.connectionId,
    provider: connection.provider,
    folder: {
      folderId: folder.id,
      ancestorIds: folder.parents.map((p) => p.id),
      path,
    },
    targetEntityId: data.targetEntityId,
    boundBy: data.actorUserId,
    options: data.options,
    ...(start === null ? {} : { startCursor: start.next }),
  }).pipe(
    Effect.catchTags({
      BindingRefused: (e) =>
        Effect.fail(new JobPermanent({ reason: e.reason })),
      BindingStoreFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'binding store unavailable' })),
    }),
  )
  const queue = yield* Enqueue
  const sync = yield* queue.enqueue(
    QUEUES.syncStorageBinding,
    { bindingId: bound.id },
    { singletonKey: bound.id },
  )
  return sync === null
    ? `bound ${path} as ${bound.id}; its first sync could not be sent`
    : `bound ${path} as ${bound.id}`
})

export const bindStorageFolder: JobDef<
  BindStorageFolderData,
  StorageSources | Enqueue
> = {
  name: QUEUES.bindStorageFolder,
  schema: bindStorageFolderData,
  // The record it was linked on: the run shows in that record's history.
  refs: (data) => ({ entityId: data.targetEntityId }),
  // Retries are for a store that blinked; a rate limit reschedules itself.
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) => Effect.scoped(program(data)),
}
