import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, documentRevision, pendingBlob } from '@spaces/db/schema'
import type { StorageEntry, StorageSource } from '@spaces/sdk'
import { MAX_UPLOAD_BYTES } from '../../documents'
import { readableOf } from '../../documents/web-stream'
import { Enqueue } from '../../queue/enqueue'
import { QUEUES } from '../../queue/names'
import {
  DocumentTooLarge,
  documentIntakeMessage,
  putBlobProgram,
} from '../documents/intake'
import { BindingStoreFailed } from './bind'
import { goneNot } from './gone'
import type { MovableDocument } from './move'
import type { SyncFailure } from './sync'

/**
 * A held document's bytes changed at the provider: the row advances to the
 * new sha and the prior sha becomes a `document_revision`.
 * - The revision id is the port's `changeToken`, never the sha: a Docs
 *   export of an unchanged Doc hashes differently every time.
 * - A token equal to the stored one is no change and reads nothing — which
 *   is also why our own export, seen again by the poll, is a no-op.
 * - The advance is a compare-and-set on the row's sha and token, so a
 *   replayed page or a racing poll advances once; the unique
 *   (document_id, external_revision_id) index is the backstop.
 * - The prior blob is kept: the revision row references it.
 * - A `gone` row is never revised: it stopped tracking (`markGoneProgram`).
 */

/** A document held for a connection, as the change poll compares it. */
export type HeldDocument = MovableDocument & {
  readonly bindingId: string | null
  readonly blobSha: string | null
  readonly externalRevisionId: string | null
  readonly externalStatus: 'linked' | 'gone' | null
}

export type ReviseOutcome =
  /** Same token, or the same bytes under a new token (the token is stored). */
  | { readonly _tag: 'unchanged' }
  /** The row advanced; extraction re-sent. */
  | { readonly _tag: 'revised' }
  | { readonly _tag: 'skipped'; readonly reason: string }

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BindingStoreFailed({ cause }),
  })

/** The document held for (connection, external id), or null. */
export const heldDocumentOf = (connectionId: string, externalId: string) =>
  query(
    async (): Promise<HeldDocument | null> =>
      (
        await db
          .select({
            id: document.entityId,
            bindingId: document.bindingId,
            blobSha: document.blobSha,
            externalRevisionId: document.externalRevisionId,
            externalStatus: document.externalStatus,
            sourcePath: document.sourcePath,
            filename: document.filename,
            mime: document.mime,
          })
          .from(document)
          .where(
            and(
              eq(document.connectionId, connectionId),
              eq(document.externalId, externalId),
            ),
          )
      ).at(0) ?? null,
  )

const unchanged: ReviseOutcome = { _tag: 'unchanged' }

/**
 * The token moved and the bytes are known not to have: only the token is
 * stored, by compare-and-set on the one read. A rename of a native document
 * takes this path, since its export is never byte-stable.
 */
export const keepTokenProgram = Effect.fn('keepTokenProgram')(function* (
  held: HeldDocument,
  changeToken: string,
): Effect.fn.Return<ReviseOutcome, BindingStoreFailed> {
  if (held.externalRevisionId === changeToken) return unchanged
  yield* query(() =>
    db
      .update(document)
      .set({ externalRevisionId: changeToken })
      .where(
        and(
          eq(document.entityId, held.id),
          sql`${document.externalRevisionId} is not distinct from ${held.externalRevisionId}`,
          goneNot,
        ),
      ),
  )
  return unchanged
})

/**
 * One changed entry against the document that holds it: compare tokens,
 * download only on a difference, and advance the row unless the bytes are
 * the ones it already holds.
 */
export const reviseDocumentProgram = Effect.fn('reviseDocumentProgram')(
  function* (input: {
    readonly held: HeldDocument
    readonly entry: StorageEntry
    readonly source: StorageSource
  }): Effect.fn.Return<ReviseOutcome, SyncFailure, Enqueue> {
    const { held, entry } = input
    if (held.externalRevisionId === entry.changeToken) return unchanged
    if (entry.size !== null && entry.size > MAX_UPLOAD_BYTES)
      return {
        _tag: 'skipped',
        reason: documentIntakeMessage(
          new DocumentTooLarge({ limitBytes: MAX_UPLOAD_BYTES }),
        ),
      }

    const file = yield* input.source
      .getFile(entry.id)
      .pipe(Effect.catchTag('NotFound', () => Effect.succeed(null)))
    if (file === null)
      return { _tag: 'skipped', reason: 'gone before it was read' }
    const blob = yield* putBlobProgram({
      stream: readableOf(file.stream),
      mime: file.mime,
      preparedBy: null,
    }).pipe(
      Effect.catchTag('DocumentTooLarge', (e) =>
        Effect.succeed({ skipped: documentIntakeMessage(e) }),
      ),
    )
    if ('skipped' in blob) return { _tag: 'skipped', reason: blob.skipped }

    // Compare-and-set on what this call read: a row another poll advanced
    // meanwhile is left alone, and the bytes stored here keep their
    // `pending_blob` row for the orphan sweep.
    const asRead = and(
      eq(document.entityId, held.id),
      sql`${document.blobSha} is not distinct from ${held.blobSha}`,
      sql`${document.externalRevisionId} is not distinct from ${held.externalRevisionId}`,
      goneNot,
    )
    const revised = yield* query(() =>
      db.transaction(async (tx) => {
        if (blob.sha === held.blobSha) {
          await tx
            .update(document)
            .set({ externalRevisionId: file.changeToken })
            .where(asRead)
          return false
        }
        const advanced = await tx
          .update(document)
          .set({
            blobSha: blob.sha,
            // The new bytes are held, whatever the old ones were; a
            // `retain: text` binding drops them again after extraction.
            bytesState: 'stored',
            mime: file.mime,
            sizeBytes: blob.sizeBytes,
            externalRevisionId: file.changeToken,
            extractionStatus: 'pending',
            extractionError: null,
          })
          .where(asRead)
          .returning({ id: document.entityId })
        if (advanced.length === 0) return false
        if (held.blobSha !== null)
          await tx
            .insert(documentRevision)
            .values({
              documentId: held.id,
              blobSha: held.blobSha,
              externalRevisionId: held.externalRevisionId,
            })
            .onConflictDoNothing()
        // A document row names the digest now: the intent is spent.
        await tx.delete(pendingBlob).where(eq(pendingBlob.sha, blob.sha))
        return true
      }),
    )
    if (!revised) return unchanged

    // Outside the transaction, as at birth: a queue that is down must not
    // roll back the advance. Embedding follows extraction.
    const queue = yield* Enqueue
    yield* queue.enqueue(QUEUES.extractDocument, { documentId: held.id })
    const outcome: ReviseOutcome = { _tag: 'revised' }
    return outcome
  },
)
