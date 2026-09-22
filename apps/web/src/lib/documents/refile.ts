import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, entitySpace, link } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue } from '#/lib/queue'
import { documentFilingRefusal } from '#/lib/server/shared'
import type { DocumentKind } from '@spaces/core/documents'
import type { DocumentFilingTarget } from '#/lib/server/shared'

/**
 * The three actions §3.3 lists that a filed document never had (SPA-50):
 * re-file, change kind, re-extract. Until this slice a document's filing was
 * whatever the upload said, so a misdrop was permanent short of delete —
 * which also takes the bytes and the extracted text with it.
 *
 * Effect-first through `effectFn` (CONTEXT.md → Backend paradigm), and here
 * rather than in `lib/server/documents.ts` for `lib/notes/filing.ts`'s
 * reason: the server fns are the auth check, and a test has no request. It
 * stays out of `lib/server/` so nothing it exports can be dragged into the
 * client bundle by the barrel (CLAUDE.md → Traps).
 *
 * Filing reuses the `DocumentFilingTarget` union SPA-19 introduced rather
 * than re-typing it: the same two mechanisms, never mixed — a record files
 * through `link(tagged_in)`, a space through `entity_space` — so a document
 * re-filed here is indistinguishable from one filed at upload.
 *
 * **Removing the last edge is legal.** An unfiled document keeps its row,
 * its blob and its extracted text; `/documents` and the unfiled inbox are
 * what it is then reachable through (§11.6). Unfiling is not a delete and
 * must never grow into one.
 */

/** The document named is not a document, or is not there at all. */
export class DocumentNotFound extends Schema.TaggedError<DocumentNotFound>()(
  'DocumentNotFound',
  { id: Schema.String },
) {}

/**
 * The target will not take this filing. Carries the sentence rather than a
 * code, as `FilingTargetRejected` does: each refusal has its own reason and
 * a chip row has nowhere to look one up.
 */
export class DocumentTargetRejected extends Schema.TaggedError<DocumentTargetRejected>()(
  'DocumentTargetRejected',
  { reason: Schema.String },
) {}

export class DocumentQueryFailed extends Schema.TaggedError<DocumentQueryFailed>()(
  'DocumentQueryFailed',
  { cause: Schema.Defect() },
) {}

export type DocumentRefileFailure =
  DocumentNotFound | DocumentTargetRejected | DocumentQueryFailed

/** The sentence the client is shown; a `Schema.TaggedError` carries none. */
export function documentRefileMessage(failure: unknown): string {
  if (failure instanceof DocumentTargetRejected) return failure.reason
  if (failure instanceof DocumentNotFound)
    return 'That document no longer exists'
  return 'Could not change this document’s filing'
}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentQueryFailed({ cause }),
  })

/**
 * The row must exist and must be a document. `document` is a `pgTable` keyed
 * by `entity_id`, so the join is what tells a document id from any other
 * entity id a caller could have sent.
 */
const readDocument = Effect.fn('refile.readDocument')(function* (
  documentId: string,
): Effect.fn.Return<void, DocumentNotFound | DocumentQueryFailed> {
  const rows = yield* query(() =>
    db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.entityId, documentId)),
  )
  if (rows.length === 0) return yield* new DocumentNotFound({ id: documentId })
})

/**
 * The target half. A merged-away record is refused by name rather than
 * silently accepted: filing against a tombstone hides the document on the
 * record that survived, which is the same argument `readTarget` makes for a
 * note. The kind check is `documentFilingRefusal`, shared with the upload
 * path so the two cannot drift.
 */
const readTarget = Effect.fn('refile.readTarget')(function* (
  target: DocumentFilingTarget,
): Effect.fn.Return<void, DocumentTargetRejected | DocumentQueryFailed> {
  const rows = yield* query(() =>
    db
      .select({
        kind: entity.kind,
        name: entity.canonicalName,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(entity)
      .where(eq(entity.id, target.entityId)),
  )
  const row = rows.at(0)
  if (!row)
    return yield* new DocumentTargetRejected({
      reason: 'That record no longer exists.',
    })
  if (row.mergedIntoId !== null)
    return yield* new DocumentTargetRejected({
      reason: `“${row.name}” was merged into another record — file the document against that one.`,
    })
  const refusal = documentFilingRefusal(target, row.kind)
  if (refusal !== null)
    return yield* new DocumentTargetRejected({ reason: refusal })
})

/**
 * Add one edge. `{ filed: false }` means the edge was already there — a
 * second click is the same outcome, not an error, and it writes no activity
 * row, the rule `setNoteKind` set for non-events.
 *
 * Idempotence is the database's, not a read's: `onConflictDoNothing` against
 * `link_edge_unique` and against `entity_space`'s composite primary key, so
 * two clicks racing produce one edge rather than one edge and one violation.
 */
export const fileDocumentProgram = Effect.fn('fileDocumentProgram')(function* (
  userId: string,
  input: { documentId: string; target: DocumentFilingTarget },
): Effect.fn.Return<{ filed: boolean }, DocumentRefileFailure> {
  yield* readDocument(input.documentId)
  yield* readTarget(input.target)
  const { documentId, target } = input

  return yield* query(() =>
    db.transaction(async (tx) => {
      const added =
        target.kind === 'record'
          ? await tx
              .insert(link)
              .values({
                fromEntityId: documentId,
                toEntityId: target.entityId,
                relation: 'tagged_in',
                source: 'manual',
                createdBy: userId,
              })
              .onConflictDoNothing()
              .returning({ id: link.id })
          : await tx
              .insert(entitySpace)
              .values({
                entityId: documentId,
                spaceId: target.entityId,
                source: 'manual',
                createdBy: userId,
              })
              .onConflictDoNothing()
              .returning({ id: entitySpace.entityId })
      if (added.length === 0) return { filed: false }

      // Subject is the target, object is the document — the shape
      // `document.filed` already writes, so the record's timeline and the
      // space's read a re-file without a second join rule. One verb covers
      // both directions and the meta says which: a reader scanning for "what
      // happened to this document's filing" wants one verb, not two.
      await tx.insert(activity).values({
        actorId: userId,
        verb: 'document.refiled',
        subjectEntityId: target.entityId,
        objectEntityId: documentId,
        meta: { action: 'filed', target: target.kind },
      })
      return { filed: true }
    }),
  )
})

/**
 * Remove exactly one edge, of the kind named. The other edge table is not
 * touched, so a deck filed on a company and in a space loses one and keeps
 * the other — and a document whose last edge goes keeps its row, its blob
 * and its text. Unfiling is not a delete.
 *
 * No target check, deliberately, for `unfileNoteFromProgram`'s reason: the
 * allowlist guards what may be *created*, and an edge that exists must stay
 * removable whatever its target has since become.
 *
 * `{ unfiled: false }` means there was no such edge to remove.
 */
export const unfileDocumentProgram = Effect.fn('unfileDocumentProgram')(
  function* (
    userId: string,
    input: { documentId: string; target: DocumentFilingTarget },
  ): Effect.fn.Return<{ unfiled: boolean }, DocumentRefileFailure> {
    yield* readDocument(input.documentId)
    const { documentId, target } = input

    return yield* query(() =>
      db.transaction(async (tx) => {
        const removed =
          target.kind === 'record'
            ? await tx
                .delete(link)
                .where(
                  and(
                    eq(link.fromEntityId, documentId),
                    eq(link.toEntityId, target.entityId),
                    eq(link.relation, 'tagged_in'),
                  ),
                )
                .returning({ id: link.id })
            : await tx
                .delete(entitySpace)
                .where(
                  and(
                    eq(entitySpace.entityId, documentId),
                    eq(entitySpace.spaceId, target.entityId),
                  ),
                )
                .returning({ id: entitySpace.entityId })
        if (removed.length === 0) return { unfiled: false }

        await tx.insert(activity).values({
          actorId: userId,
          verb: 'document.refiled',
          subjectEntityId: target.entityId,
          objectEntityId: documentId,
          meta: { action: 'unfiled', target: target.kind },
        })
        return { unfiled: true }
      }),
    )
  },
)

/**
 * Kind is a genre, not a folder (§3.4), and a genre read off a filename at
 * upload is a guess. Changing it is one `update` of one column: no edge
 * moves, no re-extraction, nothing else in the row changes.
 *
 * The value is narrowed by the server fn's `z.enum(DOCUMENT_KINDS)` before
 * it reaches here — the validator is the boundary, as it is for every other
 * enum the client can name.
 */
export const setDocumentKindProgram = Effect.fn('setDocumentKindProgram')(
  function* (
    userId: string,
    input: { documentId: string; kind: DocumentKind },
  ): Effect.fn.Return<
    { kind: DocumentKind; changed: boolean },
    DocumentNotFound | DocumentQueryFailed
  > {
    const { documentId, kind } = input
    const rows = yield* query(() =>
      db
        .select({ kind: document.kind })
        .from(document)
        .where(eq(document.entityId, documentId)),
    )
    const row = rows.at(0)
    if (!row) return yield* new DocumentNotFound({ id: documentId })
    if (row.kind === kind) return { kind, changed: false }

    const from = row.kind
    yield* query(() =>
      db.transaction(async (tx) => {
        await tx
          .update(document)
          .set({ kind })
          .where(eq(document.entityId, documentId))
        // The document's own stream — `from` and `to` in the meta so the
        // timeline can say which way it went without reading the row it is
        // describing, exactly as `note.kind_changed` does.
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'document.kind_changed',
          subjectEntityId: documentId,
          meta: { from, to: kind },
        })
      }),
    )
    return { kind, changed: true }
  },
)

/**
 * Ask the worker to read the file again — after a failure, after an
 * extractor improves, or after a scanned deck gets a text layer. The row
 * goes back to `pending` and its error is cleared, which is exactly the
 * state `birthDocumentProgram` leaves a fresh upload in, so `useExtractionPolling`
 * picks the result up with no reload and no second code path.
 *
 * The enqueue is **outside** the transaction, `finalizeDocumentUpload`'s
 * convention: a queue that is down must not roll back a perfectly good
 * status reset. `enqueue` answers `null` rather than throwing when it
 * cannot reach pg-boss, and the row stays `pending` and re-queueable — so
 * `queued` is reported rather than asserted.
 */
export const reExtractDocumentProgram = Effect.fn('reExtractDocumentProgram')(
  function* (
    userId: string,
    documentId: string,
  ): Effect.fn.Return<
    { queued: boolean },
    DocumentNotFound | DocumentQueryFailed
  > {
    yield* readDocument(documentId)

    yield* query(() =>
      db.transaction(async (tx) => {
        await tx
          .update(document)
          .set({
            extractionStatus: 'pending',
            extractionError: null,
            extractedAt: null,
          })
          .where(eq(document.entityId, documentId))
        await tx.insert(activity).values({
          actorId: userId,
          verb: 'document.reextract_requested',
          subjectEntityId: documentId,
        })
      }),
    )

    const jobId = yield* query(() =>
      enqueue(QUEUES.extractDocument, { documentId }),
    )
    return { queued: jobId !== null }
  },
)
