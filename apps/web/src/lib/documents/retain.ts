import { Effect, Schema } from 'effect'
import { and, eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, storageBinding } from '@spaces/db/schema'
import { storage } from '@spaces/core/writes/storage'
import { blobIsReferenced } from './blob-refs'

/**
 * `retain: text`: once a bound file's text
 * is stored, its bytes go and the row turns `remote` — the sha, the derived
 * layers and the pointer stay. Called from extraction's success path.
 * - Only a file whose binding says `text`, extracted `done`, still `stored`,
 *   with a connection and file id to fetch it back through.
 * - Never while another `stored` row, a revision or any other holder names
 *   the sha (`blobIsReferenced`): a full binding's copy is never discarded.
 * - Sensitivity is not this program's: it lives on the rows, which stay. The
 *   vision lane needs bytes, so a `remote` document is refused there rather
 *   than fetched again.
 */

export class RetainDropFailed extends Schema.TaggedError<RetainDropFailed>()(
  'RetainDropFailed',
  { cause: Schema.Defect() },
) {}

export type RetainDrop =
  /** Bytes deleted, row `remote`. */
  | { readonly _tag: 'dropped'; readonly sha: string }
  /** The row stays `stored`, and why. */
  | {
      readonly _tag: 'kept'
      readonly reason: 'full' | 'not-eligible' | 'shared'
    }

const io = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RetainDropFailed({ cause }),
  })

export const dropBytesAfterExtraction = Effect.fn('dropBytesAfterExtraction')(
  function* (
    documentId: string,
  ): Effect.fn.Return<RetainDrop, RetainDropFailed> {
    const row = (yield* io(() =>
      db
        .select({
          blobSha: document.blobSha,
          bytesState: document.bytesState,
          extractionStatus: document.extractionStatus,
          connectionId: document.connectionId,
          externalId: document.externalId,
          retain: storageBinding.retain,
        })
        .from(document)
        .innerJoin(storageBinding, eq(storageBinding.id, document.bindingId))
        .where(eq(document.entityId, documentId)),
    )).at(0)
    if (row === undefined || row.retain !== 'text')
      return { _tag: 'kept', reason: 'full' }
    const sha = row.blobSha
    if (
      sha === null ||
      row.bytesState !== 'stored' ||
      row.extractionStatus !== 'done' ||
      row.connectionId === null ||
      row.externalId === null
    )
      return { _tag: 'kept', reason: 'not-eligible' }
    if (yield* io(() => blobIsReferenced(sha, documentId)))
      return { _tag: 'kept', reason: 'shared' }
    // The row turns `remote` before the bytes go, on the sha it was read at:
    // a crash between the two leaves bytes no row holds, which the delete of
    // the sha's last row reclaims — never a `stored` row without its bytes.
    const turned = yield* io(() =>
      db
        .update(document)
        .set({ bytesState: 'remote' })
        .where(
          and(
            eq(document.entityId, documentId),
            eq(document.blobSha, sha),
            eq(document.bytesState, 'stored'),
          ),
        )
        .returning({ id: document.entityId }),
    )
    if (turned.length === 0) return { _tag: 'kept', reason: 'not-eligible' }
    yield* io(() => storage().delete(sha))
    return { _tag: 'dropped', sha }
  },
)
