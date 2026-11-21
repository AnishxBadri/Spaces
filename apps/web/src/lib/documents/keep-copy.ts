import { Readable } from 'node:stream'
import { Effect, Schema } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, pendingBlob } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import {
  documentIntakeMessage,
  putBlobProgram,
} from '@spaces/core/writes/documents/intake'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import {
  MailAttachments,
  mailAttachmentOf,
  mailAttachmentRefusalMessage,
} from '#/lib/arrival/mail-attachments'
import { fileDocumentProgram } from './refile'
import type { DocumentRefileFailure } from './refile'
import type { DocumentFilingTarget } from '#/lib/server/shared'

/**
 * Keep a copy: an email attachment whose file is still in the
 * mailbox, fetched through its connection and stored here, so `blob_sha`
 * names it from then on. A person asks for it, from a row's `···`, a card's
 * or the viewer's Source line, or by filing the file by hand.
 * - Nothing else keeps it: the automatic filing on the participants'
 *   records and accepting a newer version leave it in the mailbox.
 * - The text, chunks and vectors stay as read; nothing is extracted again.
 * - Outside the server-fn modules: a test drives it with a stub mailbox.
 */

/** Why the copy was not kept, in the sentence the client shows. */
export class KeepCopyRefused extends Schema.TaggedError<KeepCopyRefused>()(
  'KeepCopyRefused',
  { message: Schema.String },
) {}

export class KeepCopyFailed extends Schema.TaggedError<KeepCopyFailed>()(
  'KeepCopyFailed',
  { cause: Schema.Defect() },
) {}

/** The sentence a client is shown. */
export function keepCopyMessage(failure: unknown): string {
  if (failure instanceof KeepCopyRefused) return failure.message
  return 'Could not keep a copy of this file'
}

export type KeepCopyOutcome =
  /** Fetched and stored by this call. */
  | { readonly _tag: 'kept' }
  /** Its bytes were already here. */
  | { readonly _tag: 'held' }

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new KeepCopyFailed({ cause }),
  })

const refused = (message: string) => new KeepCopyRefused({ message })

export const keepCopyProgram = Effect.fn('keepCopy')(function* (
  viewerId: string,
  documentId: string,
): Effect.fn.Return<
  KeepCopyOutcome,
  KeepCopyRefused | KeepCopyFailed,
  MailAttachments
> {
  const row = (yield* io(() =>
    db
      .select({ blobSha: document.blobSha, mime: document.mime })
      .from(document)
      .where(
        and(eq(document.entityId, documentId), canReadDocumentSql(viewerId)),
      ),
  )).at(0)
  if (row === undefined) return yield* refused('That document no longer exists')
  if (row.blobSha !== null) return { _tag: 'held' }

  const target = yield* mailAttachmentOf(documentId).pipe(
    Effect.mapError((e) => new KeepCopyFailed({ cause: e.cause })),
  )
  if (target._tag === 'not-remote')
    return yield* refused('This file has no copy in a mailbox to keep')
  if (target._tag !== 'target')
    return yield* refused(mailAttachmentRefusalMessage(target))

  const mailboxes = yield* MailAttachments
  const file = yield* mailboxes
    .fetch({ connectionId: target.connectionId, pointer: target.pointer })
    .pipe(Effect.mapError((e) => refused(e.reason)))
  const blob = yield* putBlobProgram({
    stream: Readable.from([file.content]),
    mime: row.mime ?? file.mime,
    preparedBy: viewerId,
  }).pipe(
    Effect.mapError((e) =>
      e._tag === 'DocumentTooLarge'
        ? refused(documentIntakeMessage(e))
        : new KeepCopyFailed({ cause: e.cause }),
    ),
  )

  // Only a row still without bytes takes them; the intent row goes once a
  // row names them, as birth clears it.
  const kept = yield* io(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(document)
        .set({ blobSha: blob.sha, sizeBytes: blob.sizeBytes })
        .where(and(eq(document.entityId, documentId), isNull(document.blobSha)))
        .returning({ id: document.entityId })
      if (updated.length === 0) return false
      await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blob.sha))
      await tx.insert(activity).values({
        actorId: viewerId,
        verb: 'document.kept',
        subjectEntityId: documentId,
        objectEntityId: documentId,
      })
      return true
    }),
  )
  return kept ? { _tag: 'kept' } : { _tag: 'held' }
})

/**
 * File on… by hand: the edge, then the copy. Filing is the person's act and
 * stands on its own: a file with no copy to keep (any non-attachment, or a
 * disconnected mailbox's) is refused quietly, a failed store is logged, and
 * the row keeps its text either way.
 */
export const fileByHandProgram = Effect.fn('fileByHand')(function* (
  userId: string,
  input: { documentId: string; target: DocumentFilingTarget },
): Effect.fn.Return<
  { filed: boolean },
  DocumentRefileFailure,
  MailAttachments
> {
  const outcome = yield* fileDocumentProgram(userId, input)
  yield* keepCopyProgram(userId, input.documentId).pipe(
    Effect.catchTag('KeepCopyRefused', () => Effect.void),
    Effect.catchTag('KeepCopyFailed', (cause) =>
      Effect.logWarning(
        `filed ${input.documentId} by hand; its copy was not kept`,
        cause,
      ),
    ),
  )
  return outcome
})
