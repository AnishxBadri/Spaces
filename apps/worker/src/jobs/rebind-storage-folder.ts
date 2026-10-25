import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { accountConnection } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { bindingTargetOf } from '@spaces/core/writes/bindings/sync'
import {
  providerSaid,
  rebindBindingProgram,
  rebindRefusal,
  rebindScopesFor,
  rebindTargetOf,
} from '@spaces/core/writes/bindings/health'
import type { StorageSourceError } from '@spaces/sdk'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobFailure } from '../run-job'

/**
 * storage.rebind-folder — Re-bind with my connection: a paused or failing
 * folder binding checked against another member's grant, and — when
 * `commit` — moved onto it.
 * - The check always runs first: the connection must be the actor's, of the
 *   binding's provider, hold the scopes a folder read needs, and `getFolder`
 *   must answer. A folder not shared with that account is a refusal naming
 *   it, and nothing changes.
 * - A passed check's summary is the line the window shows; a refusal is the
 *   permanent reason.
 * - The commit repoints the binding and its documents (`rebindBindingProgram`)
 *   and sends a full sync, which re-lists the folder and files nothing twice;
 *   uploads still waiting to write through get their export again.
 */

export const rebindStorageFolderData = z.object({
  bindingId: z.string().uuid(),
  connectionId: z.string().uuid(),
  actorUserId: z.string().min(1),
  commit: z.boolean(),
})

export type RebindStorageFolderData = z.infer<typeof rebindStorageFolderData>

const UNCHANGED = 'nothing changed'

/** The sentences a refusal reads as in the re-bind window. */
export const REBIND_REFUSALS = {
  bindingGone: 'That folder is no longer linked',
  notAFolder: 'Only a folder binding re-binds',
  notYours: 'Not your connection',
} as const

const store = <TValue, TError>(effect: Effect.Effect<TValue, TError>) =>
  effect.pipe(
    Effect.mapError(
      () => new JobRetryable({ reason: 'binding store unavailable' }),
    ),
  )

const refuse = (reason: string) =>
  Effect.fail(new JobPermanent({ reason: `${reason} · ${UNCHANGED}` }))

const program = Effect.fn('rebindStorageFolder')(function* (
  data: RebindStorageFolderData,
) {
  const binding = yield* store(rebindTargetOf(data.bindingId))
  if (binding === null)
    return yield* new JobPermanent({ reason: REBIND_REFUSALS.bindingGone })
  if (binding.folderId === null)
    return yield* new JobPermanent({ reason: REBIND_REFUSALS.notAFolder })
  const folderId = binding.folderId
  const busy = rebindRefusal(binding.status)
  if (busy !== null) return yield* new JobPermanent({ reason: busy })

  const connection = (yield* store(
    Effect.tryPromise(() =>
      db
        .select({
          provider: accountConnection.provider,
          email: accountConnection.externalEmail,
          scopes: accountConnection.scopes,
          status: accountConnection.status,
          errorReason: accountConnection.errorReason,
          cursor: accountConnection.storageCursor,
        })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.id, data.connectionId),
            eq(accountConnection.userId, data.actorUserId),
          ),
        ),
    ),
  )).at(0)
  if (connection === undefined)
    return yield* new JobPermanent({ reason: REBIND_REFUSALS.notYours })
  const { email, provider } = connection
  if (provider !== binding.provider)
    return yield* refuse(`${email} is not a ${binding.provider} connection`)
  if (connection.status !== 'active')
    return yield* refuse(
      connection.errorReason === null
        ? `${email} needs reconnecting`
        : providerSaid(provider, connection.errorReason),
    )
  const required = rebindScopesFor(provider)
  const missing = required.filter((s) => !connection.scopes.includes(s))
  if (missing.length > 0)
    return yield* refuse(`${email} has not granted ${missing.join(', ')}`)

  const sources = yield* StorageSources
  const { source } = yield* sources
    .open({ provider, connectionId: data.connectionId })
    .pipe(Effect.mapError((e) => new JobPermanent({ reason: e.reason })))

  const fromSource = (
    error: StorageSourceError,
  ): Effect.Effect<never, JobFailure> => {
    switch (error._tag) {
      case 'NotFound':
        return refuse(
          `${providerSaid(provider, 'notFound')} · the folder isn’t shared with ${email}`,
        )
      case 'AuthExpired':
        return refuse(providerSaid(provider, error.reason))
      case 'RateLimited':
        return Effect.fail(
          new JobRateLimited({
            reason: 'The provider asked to slow down',
            retryAfterMs: error.retryAfterMs,
          }),
        )
      case 'CursorExpired':
        return Effect.fail(
          new JobRetryable({ reason: 'a provider cursor expired' }),
        )
    }
  }

  yield* source.getFolder(folderId).pipe(Effect.catch(fromSource))
  const files = `${String(binding.files)} ${binding.files === 1 ? 'file' : 'files'}`
  if (!data.commit)
    return ['Can read the folder', files, ...required].join(' · ')

  const start =
    connection.cursor === null
      ? yield* source.changes(null).pipe(Effect.catch(fromSource))
      : null
  const outcome = yield* store(
    rebindBindingProgram({
      bindingId: binding.id,
      connectionId: data.connectionId,
      actorUserId: data.actorUserId,
      ...(start === null ? {} : { startCursor: start.next }),
    }),
  )
  if (outcome._tag === 'refused')
    return yield* new JobPermanent({ reason: outcome.reason })

  const queue = yield* Enqueue
  const sync = yield* queue.enqueue(
    QUEUES.syncStorageBinding,
    { bindingId: binding.id },
    { singletonKey: binding.id },
  )
  for (const documentId of outcome.waiting)
    yield* queue.enqueue(
      QUEUES.exportDocument,
      { documentId },
      { singletonKey: documentId },
    )
  const said = `re-bound ${binding.folderPath} to ${email}; re-listing ${files}`
  return sync === null ? `${said}; its sync could not be sent` : said
})

export const rebindStorageFolder: JobDef<
  RebindStorageFolderData,
  StorageSources | Enqueue
> = {
  name: QUEUES.rebindStorageFolder,
  schema: rebindStorageFolderData,
  // The bound record: the re-bind shows in its history.
  lookupRefs: async (data) => ({
    entityId: await bindingTargetOf(data.bindingId),
  }),
  // Retries are for a store that blinked; a rate limit reschedules itself.
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) => Effect.scoped(program(data)),
}
