import { Effect, Schema } from 'effect'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity } from '@spaces/db/schema'
import { isBindableKind } from '@spaces/core/documents/bindings'
import type { RevisionRow } from '@spaces/core/documents/revisions'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import {
  documentRevisionsProgram,
  followFileProgram,
  unfollowFileProgram,
} from '@spaces/core/writes/bindings/follow'

/**
 * Follow a file from a record's Files tab, web's half: a document the
 * viewer can read, then core's file binding. Nothing here reaches the
 * provider; the worker's change poll reads the file from then on.
 * - Outside the server-fn modules so a test drives it without a request.
 */

export class FollowFailed extends Schema.TaggedError<FollowFailed>()(
  'FollowFailed',
  { cause: Schema.Defect() },
) {}

export type FollowOutcome =
  | { readonly _tag: 'followed'; readonly bindingId: string }
  | { readonly _tag: 'refused'; readonly reason: string }

const NOT_READABLE = 'That file no longer exists.'

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new FollowFailed({ cause }),
  })

/** Whether a record's Files tab offers Follow: one that may hold a binding. */
export async function followableRecord(entityId: string): Promise<boolean> {
  const row = (
    await db
      .select({ kind: entity.kind })
      .from(entity)
      .where(and(eq(entity.id, entityId), isNull(entity.mergedIntoId)))
  ).at(0)
  return row !== undefined && isBindableKind(row.kind)
}

const readable = (userId: string, documentId: string) =>
  query(async () => {
    const rows = await db
      .select({ id: document.entityId })
      .from(document)
      .where(and(eq(document.entityId, documentId), canReadDocumentSql(userId)))
    return rows.length > 0
  })

export const followDocumentProgram = Effect.fn('followDocumentProgram')(
  function* (
    userId: string,
    input: { readonly documentId: string; readonly recordId: string },
  ): Effect.fn.Return<FollowOutcome, FollowFailed> {
    if (!(yield* readable(userId, input.documentId)))
      return { _tag: 'refused', reason: NOT_READABLE }
    return yield* followFileProgram({
      documentId: input.documentId,
      targetEntityId: input.recordId,
      userId,
    }).pipe(
      Effect.map((followed): FollowOutcome => ({
        _tag: 'followed',
        bindingId: followed.bindingId,
      })),
      Effect.catchTags({
        BindingRefused: (e) =>
          Effect.succeed<FollowOutcome>({ _tag: 'refused', reason: e.reason }),
        BindingStoreFailed: (e) =>
          Effect.fail(new FollowFailed({ cause: e.cause })),
      }),
    )
  },
)

/** Unfollow: the poll stops reading it; every revision stays. */
export const unfollowDocumentProgram = Effect.fn('unfollowDocumentProgram')(
  function* (
    userId: string,
    documentId: string,
  ): Effect.fn.Return<boolean, FollowFailed> {
    if (!(yield* readable(userId, documentId))) return false
    return yield* unfollowFileProgram(documentId).pipe(
      Effect.mapError((e) => new FollowFailed({ cause: e.cause })),
    )
  },
)

/** The revision ledger of a document the viewer can read, newest first. */
export const documentRevisionsForProgram = Effect.fn(
  'documentRevisionsForProgram',
)(function* (
  userId: string,
  documentId: string,
): Effect.fn.Return<ReadonlyArray<RevisionRow> | null, FollowFailed> {
  if (!(yield* readable(userId, documentId))) return null
  return yield* documentRevisionsProgram(documentId).pipe(
    Effect.mapError((e) => new FollowFailed({ cause: e.cause })),
  )
})
