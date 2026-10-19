import { Effect, Schema } from 'effect'
import { and, count, desc, eq, isNull, max, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { chunk, document, entity, link, note } from '@spaces/db/schema'
import { canRead } from '@spaces/core/read-policy'
import {
  canReadDocumentSql,
  noteWidenedSql,
} from '@spaces/core/writes/read/can-read-sql'

/**
 * What the file viewer's sidebar and the Remove confirm say about one
 * document beyond its Files-tab row: what leaves with it (chunks), what was
 * read (words, pages) and which notes mention it.
 * - A document the viewer cannot read answers null; private notes they
 *   cannot read are left out, not counted.
 * - Outside `lib/server/` so it never reaches the client barrel.
 */

export class DocumentDetailsFailed extends Schema.TaggedError<DocumentDetailsFailed>()(
  'DocumentDetailsFailed',
  { cause: Schema.Defect() },
) {}

export type DocumentDetails = {
  /** Chunks cut from its text — what leaves the server with it. */
  readonly chunks: number
  /** Words in the extracted text; null when nothing was read. */
  readonly words: number | null
  /** The highest page a chunk was cut from; null when no chunk knows its page. */
  readonly pages: number | null
  readonly sha: string | null
  readonly mentionedIn: ReadonlyArray<{
    readonly id: string
    readonly name: string
    /** When the mention was made, ISO. */
    readonly at: string
  }>
}

const query = <TRow>(run: () => Promise<TRow>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new DocumentDetailsFailed({ cause }),
  })

export const documentDetailsProgram = Effect.fn('documentDetailsProgram')(
  function* (
    viewer: { readonly id: string },
    documentId: string,
  ): Effect.fn.Return<DocumentDetails | null, DocumentDetailsFailed> {
    const row = (yield* query(() =>
      db
        .select({
          sha: document.blobSha,
          words: sql<number | null>`case
            when btrim(coalesce(${document.extractedText}, '')) = '' then null
            else array_length(regexp_split_to_array(btrim(${document.extractedText}), '\\s+'), 1)
          end`,
        })
        .from(document)
        .where(
          and(eq(document.entityId, documentId), canReadDocumentSql(viewer.id)),
        ),
    )).at(0)
    // A document the viewer may not read has no details, as one that is gone.
    if (row === undefined) return null

    const cut = (yield* query(() =>
      db
        .select({ chunks: count(), pages: max(chunk.page) })
        .from(chunk)
        .where(eq(chunk.entityId, documentId)),
    )).at(0)

    const mentions = yield* query(() =>
      db
        .select({
          id: note.entityId,
          title: note.title,
          name: entity.canonicalName,
          visibility: note.visibility,
          authorId: note.authorId,
          widened: noteWidenedSql(viewer.id),
          at: link.createdAt,
        })
        .from(link)
        .innerJoin(note, eq(note.entityId, link.fromEntityId))
        .innerJoin(entity, eq(entity.id, link.fromEntityId))
        .where(
          and(
            eq(link.toEntityId, documentId),
            eq(link.relation, 'mentions'),
            isNull(entity.mergedIntoId),
          ),
        )
        .orderBy(desc(link.createdAt)),
    )

    return {
      chunks: cut?.chunks ?? 0,
      words: row.words === null ? null : Number(row.words),
      pages: cut?.pages ?? null,
      sha: row.sha,
      mentionedIn: mentions
        .filter((m) => canRead(viewer, m))
        .map((m) => ({
          id: m.id,
          name: m.title || m.name,
          at: m.at.toISOString(),
        })),
    }
  },
)
