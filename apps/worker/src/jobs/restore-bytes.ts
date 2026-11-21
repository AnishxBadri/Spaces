import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { uuid } from '../job-data'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { QUEUES } from '@spaces/core/queue/names'
import {
  remoteBytesOf,
  remoteBytesRefusalMessage,
  restoreBytesProgram,
} from '@spaces/core/writes/bindings/retain'
import type { RestoreFailure } from '@spaces/core/writes/bindings/retain'
import {
  documentIntakeMessage,
  putBlobProgram,
} from '@spaces/core/writes/documents/intake'
import {
  MailAttachments,
  mailAttachmentOf,
  mailAttachmentRefusalMessage,
} from '#web/lib/arrival/mail-attachments'
import type { MailAttachmentTarget } from '#web/lib/arrival/mail-attachments'
import { StorageSources } from './storage-sources'
import { JobPermanent, JobRateLimited, JobRetryable } from '../run-job'
import type { JobDef, JobFailure } from '../run-job'

/**
 * A `remote` document's bytes fetched back through the connection it came
 * through (`retain: text`), or an email attachment's from its mailbox.
 * - `storage.fetch-bytes` is the viewer's: the bytes land under their sha
 *   with a `pending_blob` intent, so the orphan sweep reclaims them again.
 *   An attachment's row keeps its empty `blob_sha`; Keep a copy is what
 *   stores it for good.
 * - `storage.retain-backfill` is a `text → full` flip's: the row turns
 *   `stored` and keeps them.
 * - Every refusal is a `JobPermanent` whose reason the viewer shows.
 */

export const restoreBytesData = Schema.Struct({
  documentId: uuid,
})

export type RestoreBytesData = typeof restoreBytesData.Type

/** The bytes hash differently at the provider: the viewer's sentence. */
export const REMOTE_BYTES_CHANGED =
  'The file changed in its source since its text was read; the next sync brings the new version'

const fromRestore = (error: RestoreFailure): JobFailure => {
  switch (error._tag) {
    case 'NotFound':
      return new JobPermanent({
        reason:
          'The file is no longer in its source; only its text is kept here',
      })
    case 'AuthExpired':
      return new JobPermanent({ reason: error.reason })
    case 'RateLimited':
      return new JobRateLimited({
        reason: 'The provider asked to slow down',
        retryAfterMs: error.retryAfterMs,
      })
    case 'DocumentIntakeFailed':
      return new JobRetryable({ reason: 'could not store the file' })
    case 'BindingStoreFailed':
      return new JobRetryable({ reason: 'document store unavailable' })
  }
}

/** The attachment's file from its mailbox, into the viewer's cache. */
const cacheMailAttachment = Effect.fn('cacheMailAttachment')(function* (
  target: MailAttachmentTarget,
) {
  const mailboxes = yield* MailAttachments
  const file = yield* mailboxes
    .fetch({ connectionId: target.connectionId, pointer: target.pointer })
    .pipe(
      Effect.mapError((e) =>
        e.retryable
          ? new JobRetryable({ reason: e.reason })
          : new JobPermanent({ reason: e.reason }),
      ),
    )
  const blob = yield* putBlobProgram({
    stream: Readable.from([file.content]),
    mime: file.mime,
    preparedBy: null,
  }).pipe(
    Effect.mapError((e) =>
      e._tag === 'DocumentTooLarge'
        ? new JobPermanent({ reason: documentIntakeMessage(e) })
        : new JobRetryable({ reason: 'could not store the file' }),
    ),
  )
  return `fetched ${blob.sha.slice(0, 12)} from Gmail`
})

const program = (keep: boolean) =>
  Effect.fn(keep ? 'retainBackfill' : 'fetchRemoteBytes')(function* (
    data: RestoreBytesData,
  ) {
    if (!keep) {
      const mail = yield* mailAttachmentOf(data.documentId).pipe(
        Effect.mapError(
          () => new JobRetryable({ reason: 'document store unavailable' }),
        ),
      )
      if (mail._tag === 'target') return yield* cacheMailAttachment(mail)
      if (mail._tag !== 'not-remote')
        return yield* new JobPermanent({
          reason: mailAttachmentRefusalMessage(mail),
        })
    }
    const target = yield* remoteBytesOf(data.documentId).pipe(
      Effect.mapError(fromRestore),
    )
    if (target._tag !== 'target')
      return yield* new JobPermanent({
        reason: remoteBytesRefusalMessage(target),
      })
    // Already held: a backfill sent twice, or a sibling row brought them.
    if (target.bytesState === 'stored') return 'already stored'
    const sources = yield* StorageSources
    const { source } = yield* sources
      .open({ provider: target.provider, connectionId: target.connectionId })
      .pipe(Effect.mapError((e) => new JobPermanent({ reason: e.reason })))
    const outcome = yield* restoreBytesProgram({ target, source, keep }).pipe(
      Effect.mapError(fromRestore),
    )
    switch (outcome._tag) {
      case 'restored':
        return keep
          ? `stored ${target.blobSha.slice(0, 12)}`
          : `fetched ${target.blobSha.slice(0, 12)}`
      case 'changed':
        if (keep)
          return 'the file changed in its source; stored the new version'
        return yield* new JobPermanent({ reason: REMOTE_BYTES_CHANGED })
      case 'skipped':
        return yield* new JobPermanent({ reason: outcome.reason })
    }
  })

const retry = { limit: 2, delaySeconds: 30, backoff: true } as const

export const fetchRemoteBytes: JobDef<
  RestoreBytesData,
  StorageSources | Enqueue | MailAttachments
> = {
  name: QUEUES.fetchRemoteBytes,
  schema: restoreBytesData,
  refs: (data) => ({ entityId: data.documentId }),
  retry,
  run: (data) => Effect.scoped(program(false)(data)),
}

export const retainBackfill: JobDef<
  RestoreBytesData,
  StorageSources | Enqueue | MailAttachments
> = {
  name: QUEUES.retainBackfill,
  schema: restoreBytesData,
  refs: (data) => ({ entityId: data.documentId }),
  retry,
  run: (data) => Effect.scoped(program(true)(data)),
}
