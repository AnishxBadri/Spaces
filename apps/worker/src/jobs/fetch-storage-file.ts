import { Effect, Schema } from 'effect'
import type { Layer } from 'effect'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { accountConnection, document } from '@spaces/db/schema'
import { guessDocumentKind } from '@spaces/core/documents'
import { readableOf } from '@spaces/core/documents/web-stream'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import { canonicalFileUrl } from '@spaces/core/writes/connections/sources'
import {
  documentIntakeMessage,
  intakeDocumentProgram,
} from '@spaces/core/writes/documents/intake'
import type { StorageSource, StorageSourceError } from '@spaces/sdk'
import {
  documentRefileMessage,
  fileDocumentProgram,
} from '#web/lib/documents/refile'
import { enqueue } from '#web/lib/queue'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobFailure } from '../run-job'

/**
 * document.fetch-storage — a pasted storage-source link, or one file picked
 * in the provider's picker (as the provider's own link for it), fetched with
 * that user's grant and filed on the record it was attached on.
 * - A file this connection already brought in (`connection_id`,
 *   `external_id`) is filed again and never downloaded again.
 * - The bytes go through intake, so `MAX_UPLOAD_BYTES` is metered on the
 *   stream and extraction is queued like any arrival; `source_path` is the
 *   file's folder path from `getFolder`.
 * - Every refusal is a `JobPermanent` whose reason the Files tab shows on
 *   the pending row; only a rate limit or a store that blinked retries.
 */

export const fetchStorageFileData = z.object({
  url: z.string().url(),
  connectionId: z.string().uuid(),
  attachTo: z.string().uuid(),
  actorUserId: z.string().min(1),
})

export type FetchStorageFileData = z.infer<typeof fetchStorageFileData>

/** The sentences a refusal reads as on the row. */
export const FETCH_REFUSALS = {
  notAFile: 'That link does not point at a file',
  folder: 'That is a folder; linking a folder comes later',
  notFound: 'The link points at nothing your account can read',
  connectionGone: 'The connection this link was pasted with is gone',
} as const

/** The connection row is not one the pasting user holds. */
class ConnectionMissing extends Schema.TaggedError<ConnectionMissing>()(
  'ConnectionMissing',
  {},
) {}

const store = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new JobRetryable({
        reason: `document store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/** The provider's failure as the job's outcome. */
const fromSource = (error: StorageSourceError): JobFailure => {
  switch (error._tag) {
    case 'NotFound':
      return new JobPermanent({ reason: FETCH_REFUSALS.notFound })
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

/**
 * The folder path as the provider shows it, root first: "My Drive / Data
 * room / Legal". Null for a file at a root, or whose folder this connection
 * cannot see — the path is a label, never a reason to refuse the file.
 */
const pathOf = (source: StorageSource, parentId: string | null) =>
  parentId === null
    ? Effect.succeed(null)
    : source.getFolder(parentId).pipe(
        Effect.map((folder) =>
          [...folder.parents.map((p) => p.name), folder.name].join(' / '),
        ),
        Effect.catchTag('NotFound', () => Effect.succeed(null)),
        Effect.mapError(fromSource),
      )

const connectionOf = (connectionId: string, userId: string) =>
  store(async () =>
    (
      await db
        .select({ provider: accountConnection.provider })
        .from(accountConnection)
        .where(
          and(
            eq(accountConnection.id, connectionId),
            eq(accountConnection.userId, userId),
          ),
        )
    ).at(0),
  ).pipe(
    Effect.flatMap((row) =>
      row === undefined
        ? Effect.fail(new ConnectionMissing())
        : Effect.succeed(row),
    ),
  )

const heldDocument = (connectionId: string, fileId: string) =>
  store(
    async () =>
      (
        await db
          .select({ id: document.entityId })
          .from(document)
          .where(
            and(
              eq(document.connectionId, connectionId),
              eq(document.externalId, fileId),
            ),
          )
      ).at(0)?.id ?? null,
  )

/** The held document, filed on the record too; no byte is read. */
const fileHeld = Effect.fn('fetchStorageFile.fileHeld')(function* (
  data: FetchStorageFileData,
  documentId: string,
) {
  const { filed } = yield* fileDocumentProgram(data.actorUserId, {
    documentId,
    target: { kind: 'record', entityId: data.attachTo },
  }).pipe(
    Effect.catchTags({
      DocumentQueryFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'document store unavailable' })),
      DocumentNotFound: (e) =>
        Effect.fail(new JobPermanent({ reason: documentRefileMessage(e) })),
      DocumentTargetRejected: (e) =>
        Effect.fail(new JobPermanent({ reason: documentRefileMessage(e) })),
    }),
  )
  return filed
    ? `already held ${documentId}; filed here`
    : `already held ${documentId}`
})

const program = Effect.fn('fetchStorageFile')(function* (
  data: FetchStorageFileData,
) {
  const { provider } = yield* connectionOf(data.connectionId, data.actorUserId)
  const sources = yield* StorageSources
  const { integrationId, source } = yield* sources
    .open({ provider, connectionId: data.connectionId })
    .pipe(Effect.mapError((e) => new JobPermanent({ reason: e.reason })))

  const target = yield* source
    .resolveLink(data.url)
    .pipe(Effect.mapError(fromSource))
  if (target === null)
    return yield* new JobPermanent({ reason: FETCH_REFUSALS.notAFile })
  if (!('fileId' in target))
    return yield* new JobPermanent({ reason: FETCH_REFUSALS.folder })
  const { fileId } = target

  const held = yield* heldDocument(data.connectionId, fileId)
  if (held !== null) return yield* fileHeld(data, held)

  const file = yield* source.getFile(fileId).pipe(Effect.mapError(fromSource))
  const sourcePath = yield* pathOf(source, file.parentId ?? null).pipe(
    Effect.tapError(() =>
      Effect.promise(() => file.stream.cancel().catch(() => undefined)),
    ),
  )
  const born = yield* intakeDocumentProgram({
    stream: readableOf(file.stream),
    filename: file.name,
    mime: file.mime,
    // The port reports no size, and an export has none: the meter decides.
    declaredSize: null,
    kind: guessDocumentKind(file.name),
    sourceClass: 'integration',
    sourceRef: integrationId,
    provenance: {
      sourcePath,
      externalId: fileId,
      externalUrl: canonicalFileUrl(provider, fileId),
      connectionId: data.connectionId,
      // The revision read, so a follow later compares against it.
      externalRevisionId: file.changeToken,
    },
    fileAgainst: [{ kind: 'record', entityId: data.attachTo }],
    actor: { userId: data.actorUserId },
  }).pipe(
    Effect.map((outcome) => ({ ...outcome, raced: false })),
    Effect.catchTags({
      DocumentTooLarge: (e) =>
        Effect.fail(new JobPermanent({ reason: documentIntakeMessage(e) })),
      DocumentBirthRejected: (e) =>
        Effect.fail(new JobPermanent({ reason: documentIntakeMessage(e) })),
      DocumentIntakeFailed: () =>
        Effect.fail(new JobRetryable({ reason: 'could not store the file' })),
      // A second paste raced this one past the held check: the unique
      // (connection_id, external_id) refused the row, so file the winner.
      DocumentBirthFailed: () =>
        heldDocument(data.connectionId, fileId).pipe(
          Effect.flatMap((winner) =>
            winner === null
              ? Effect.fail(
                  new JobRetryable({ reason: 'could not file the document' }),
                )
              : Effect.succeed({ id: winner, deduped: true, raced: true }),
          ),
        ),
    }),
  )
  if (born.raced) return yield* fileHeld(data, born.id)
  return born.deduped
    ? `${file.name}: same bytes already filed here as ${born.id}`
    : `fetched ${file.name} as ${born.id}`
})

/** Extraction's enqueue from this job: the worker's sender over web's queue module. */
export const fetchStorageEnqueue: Layer.Layer<Enqueue> = Enqueue.fromSender({
  enqueue: (queue, data, options) => enqueue(queue, data, options),
})

export const fetchStorageFile: JobDef<
  FetchStorageFileData,
  StorageSources | Enqueue
> = {
  name: QUEUES.fetchStorageFile,
  schema: fetchStorageFileData,
  // The record it was pasted on: the run shows in that record's history.
  refs: (data) => ({ entityId: data.attachTo }),
  // Retries are for a store that blinked; a rate limit reschedules itself.
  retry: { limit: 2, delaySeconds: 30, backoff: true },
  run: (data) =>
    Effect.scoped(program(data)).pipe(
      Effect.catchTag('ConnectionMissing', () =>
        Effect.fail(
          new JobPermanent({ reason: FETCH_REFUSALS.connectionGone }),
        ),
      ),
    ),
}
