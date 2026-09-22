import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, isNull, notExists, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import { document, entity, entitySpace, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'

/**
 * The documents filed **into** one space (SPA-44) — the space-page twin of
 * `listRecordDocuments`' lane, and the same row shape.
 *
 * Filing into a space is `entity_space`, never `link(tagged_in)`
 * (CONTEXT.md → Sources are documents; `DocumentFilingTarget` in
 * `lib/server/shared.ts`), which is why this cannot reuse the Files-tab
 * query: that one reads the edge a record filing writes, and a space
 * filing writes the other table entirely.
 *
 * It lives outside `lib/server/` on purpose. `lib/server/spaces.ts` is
 * reachable from the client barrel, and a plain export there ships to the
 * browser (CLAUDE.md → Traps, SPA-155); `lib/notes/filed.ts` is the same
 * arrangement for the space page's notes lane, and a test can call this
 * without a request.
 *
 * `entity.merged_into_id` is filtered in SQL, as everywhere else on this
 * page: a document merged away stops being a source of the space it was
 * filed into.
 *
 * SPA-67 added the second lane the spec asks for —
 * `spaceInheritedSourcesProgram`, the documents reached *through* the
 * companies tagged into the space. Two programs rather than one union
 * because they answer different questions and the page renders them
 * differently: the direct lane is the section, the inherited lane is a
 * closed disclosure under it and never touches the headline count.
 */

export class SpaceSourcesFailed extends Schema.TaggedError<SpaceSourcesFailed>()(
  'SpaceSourcesFailed',
  { cause: Schema.Defect() },
) {}

export type SpaceSource = {
  id: string
  filename: string
  kind: (typeof document.$inferSelect)['kind']
  sizeBytes: number | null
  mime: string | null
  extractionStatus: (typeof document.$inferSelect)['extractionStatus']
  extractionError: string | null
  /**
   * Whether the row has bytes behind it (docsurf-10b). Null on a clipped
   * article, which was read and never stored, and the row's controls read
   * it: with no blob there is no download to offer, so the control becomes
   * "Open source" against the `url` below instead of a button that throws.
   */
  blobSha: string | null
  /**
   * The clip's own address (SPA-117), null for every document that arrived
   * as bytes. It is what lets the row say "fetching…" while a saved link
   * waits on the worker, where a deck says "extracting text…".
   */
  url: string | null
  uploadedByName: string | null
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  createdAt: string
  /**
   * How long ago it was filed, in ms, measured on the **server**. A relative
   * time read off the browser's clock renders one string during SSR and
   * another during hydration, which is a mismatch — the Files tab computes
   * its `sinceMs` here for exactly this reason.
   */
  sinceMs: number
  snippet: string | null
}

/**
 * A document reached through a company tagged into this space (SPA-67) —
 * the inherited half of spec-storage-sources §3.2. Same row as a direct
 * source plus the company it came in on, because a row a person did not
 * file here has to say why it is on the page at all.
 */
export type InheritedSource = SpaceSource & {
  companyId: string
  companyName: string
}

/**
 * Enough extracted text to prove the worker landed, and not a byte more:
 * the column runs to 2MB and nothing on a space page wants it. Same 200 as
 * the Files tab, for the same reason.
 */
const SNIPPET_CHARS = 200

/**
 * The columns both lanes read. One object, so the two queries cannot drift
 * into answering with different row shapes — the section renders them with
 * the same component.
 */
const sourceColumns = {
  id: document.entityId,
  filename: document.filename,
  kind: document.kind,
  sizeBytes: document.sizeBytes,
  mime: document.mime,
  extractionStatus: document.extractionStatus,
  extractionError: document.extractionError,
  blobSha: document.blobSha,
  url: document.url,
  createdAt: document.createdAt,
  uploadedByName: user.name,
  snippet: sql<
    string | null
  >`left(${document.extractedText}, ${SNIPPET_CHARS})`,
}

type SourceRow = Pick<
  typeof document.$inferSelect,
  | 'filename'
  | 'kind'
  | 'sizeBytes'
  | 'mime'
  | 'extractionStatus'
  | 'extractionError'
  | 'blobSha'
  | 'url'
  | 'createdAt'
> & { id: string; uploadedByName: string | null; snippet: string | null }

/** `now` is passed in so every row of one read shares one clock. */
function toSource(r: SourceRow, now: number): SpaceSource {
  return {
    id: r.id,
    filename: r.filename ?? 'Untitled file',
    kind: r.kind,
    sizeBytes: r.sizeBytes,
    mime: r.mime,
    extractionStatus: r.extractionStatus,
    extractionError: r.extractionError,
    blobSha: r.blobSha,
    url: r.url,
    uploadedByName: r.uploadedByName,
    createdAt: r.createdAt.toISOString(),
    sinceMs: now - r.createdAt.getTime(),
    snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
  }
}

export const spaceSourcesProgram = Effect.fn('spaceSourcesProgram')(function* (
  spaceId: string,
): Effect.fn.Return<Array<SpaceSource>, SpaceSourcesFailed> {
  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select(sourceColumns)
        .from(entitySpace)
        .innerJoin(document, eq(document.entityId, entitySpace.entityId))
        .innerJoin(entity, eq(entity.id, document.entityId))
        // Left, not inner: `uploaded_by` is nullable, and a document a
        // connector filed with no user behind it must still be a source.
        .leftJoin(user, eq(user.id, document.uploadedBy))
        .where(
          and(eq(entitySpace.spaceId, spaceId), isNull(entity.mergedIntoId)),
        )
        .orderBy(desc(document.createdAt)),
    catch: (cause) => new SpaceSourcesFailed({ cause }),
  })

  const now = Date.now()
  return rows.map((r) => toSource(r, now))
})

/**
 * The inherited lane (SPA-67): documents `tagged_in` a company that is
 * itself tagged into this space. One statement, not a query per company —
 * a space with forty companies is ordinary and forty round trips is not.
 *
 * Three things the joins have to get right:
 *
 * - **Two `entity` rows are in play**, the company's and the document's, so
 *   both are aliased and `merged_into_id` is checked on each. A company
 *   merged away stops lending its documents; a document merged away stops
 *   being one.
 * - **A doubly-filed document appears once.** If it also has an
 *   `entity_space` row for this space it is a *direct* source — filed here
 *   deliberately — so the `not exists` below drops it from this lane rather
 *   than letting the page show it twice with two different stories.
 * - **The count is per edge, not per document.** A deck tagged into two
 *   companies that are both in this space is two rows, one under each
 *   company, which is what the company column is for; `link_edge_unique`
 *   is what stops the same pair arriving twice.
 *
 * Inheritance is never folded into the section's headline count. The
 * headline says what was filed here; this is a convenience lane.
 */
export const spaceInheritedSourcesProgram = Effect.fn(
  'spaceInheritedSourcesProgram',
)(function* (
  spaceId: string,
): Effect.fn.Return<Array<InheritedSource>, SpaceSourcesFailed> {
  const companyEntity = alias(entity, 'company_entity')
  const documentEntity = alias(entity, 'document_entity')
  const filedHere = alias(entitySpace, 'filed_here')

  const rows = yield* Effect.tryPromise({
    try: () =>
      db
        .select({
          ...sourceColumns,
          companyId: companyEntity.id,
          companyName: companyEntity.canonicalName,
        })
        .from(entitySpace)
        .innerJoin(companyEntity, eq(companyEntity.id, entitySpace.entityId))
        .innerJoin(
          link,
          and(
            eq(link.toEntityId, companyEntity.id),
            eq(link.relation, 'tagged_in'),
          ),
        )
        .innerJoin(document, eq(document.entityId, link.fromEntityId))
        .innerJoin(documentEntity, eq(documentEntity.id, document.entityId))
        .leftJoin(user, eq(user.id, document.uploadedBy))
        .where(
          and(
            eq(entitySpace.spaceId, spaceId),
            eq(companyEntity.kind, 'company'),
            isNull(companyEntity.mergedIntoId),
            isNull(documentEntity.mergedIntoId),
            notExists(
              db
                .select({ filed: sql`1` })
                .from(filedHere)
                .where(
                  and(
                    eq(filedHere.entityId, document.entityId),
                    eq(filedHere.spaceId, spaceId),
                  ),
                ),
            ),
          ),
        )
        // Newest first, as the direct lane is; the company name breaks the
        // tie so two decks filed in the same second still order the same
        // way on every render.
        .orderBy(desc(document.createdAt), asc(companyEntity.canonicalName)),
    catch: (cause) => new SpaceSourcesFailed({ cause }),
  })

  const now = Date.now()
  return rows.map((r) => ({
    ...toSource(r, now),
    companyId: r.companyId,
    companyName: r.companyName,
  }))
})
