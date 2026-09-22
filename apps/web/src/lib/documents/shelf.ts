import { Effect, Schema } from 'effect'
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { documentFilingEdges } from '#/lib/server/shared'
import { unfiledPredicate } from '#/lib/documents/unfiled'

/**
 * The shelf behind `/documents` (SPA-58) — every document in the workspace
 * as one row, with the filing resolved.
 *
 * `listRecordDocuments` is the shape this generalizes, and the one thing it
 * could not be reused for: that query starts at `link` and answers **one row
 * per filing**, so a deck filed against a company and a deal arrives twice.
 * A shelf is a list of documents, not of edges, so this starts at `document`
 * and folds the edges in.
 *
 * Three statements, and that ceiling is the design rather than an
 * optimisation: the obvious shape — a row, then its records, then its spaces
 * — is 2N+1 round trips on a workspace where N is every file the fund owns.
 * One read of the documents, one of `link(tagged_in)`, one of `entity_space`,
 * the last two being `documentFilingEdges` (`lib/server/shared.ts`), which is
 * the same reader the Files tab's filing control already uses. A fourth edge
 * reader here is how the two would have drifted.
 *
 * `sourceCapability` rides along the first statement rather than through
 * `documentProvenance`, which would have been a fourth: the join it makes is
 * one `left join integration`, and the first statement is already selecting
 * from `document`.
 *
 * The `filed` filter (SPA-124) is one `where` clause on statement one — the
 * three-statement ceiling above is the design, so the unfiled inbox is a
 * predicate on the shelf and not a fourth read, and not a route of its own.
 * The predicate itself is `unfiledPredicate()`, shared with the count Today's
 * badge reads.
 *
 * It lives outside `lib/server/` for the reason `space-sources.ts` does
 * (CLAUDE.md → Traps, SPA-155): `lib/server/documents.ts` is re-exported by
 * the client barrel, and a plain export there ships to the browser. Here a
 * test can call it without a request.
 */

export class DocumentShelfFailed extends Schema.TaggedError<DocumentShelfFailed>()(
  'DocumentShelfFailed',
  { cause: Schema.Defect() },
) {}

/**
 * A record this document is filed against. `kind` and `objectSlug` are both
 * here because `recordPath` needs both to route a custom record, and the
 * chip has nowhere else to get them.
 */
export type ShelfRecord = {
  id: string
  name: string
  kind: string
  objectSlug: string | null
}

/** A space this document is filed into. Spaces route on id alone. */
export type ShelfSpace = { id: string; name: string }

export type ShelfDocument = {
  id: string
  filename: string
  kind: (typeof document.$inferSelect)['kind']
  sizeBytes: number | null
  mime: string | null
  extractionStatus: (typeof document.$inferSelect)['extractionStatus']
  extractionError: string | null
  sourceClass: (typeof document.$inferSelect)['sourceClass']
  /** The integration that filed it, named; null for a manual upload. */
  sourceCapability: string | null
  /**
   * The three storage-source columns the Source column reads (SPA-78,
   * `docs/spec-storage-sources.md` §11 delta 1). All three are null on every
   * document until a storage-source plugin files one, and the column renders
   * exactly what it rendered before when they are — a null path is not an
   * empty cell, it is the origin on its own.
   *
   * `external_id` and `connection_id` are the other two columns of that delta
   * and are deliberately not here: they are the sync's idempotency key, not
   * anything a reader sees, and a shelf row is what the shelf renders.
   */
  sourcePath: string | null
  externalUrl: string | null
  externalStatus: (typeof document.$inferSelect)['externalStatus']
  uploadedByName: string | null
  /** ISO 8601 — compared lexically, the repo convention for dates. */
  createdAt: string
  /**
   * How long ago it was filed, in ms, measured on the **server**. A relative
   * time read off the browser's clock renders one string during SSR and
   * another during hydration, which is a mismatch — every other document
   * surface computes `sinceMs` here for the same reason.
   */
  sinceMs: number
  snippet: string | null
  records: Array<ShelfRecord>
  spaces: Array<ShelfSpace>
}

/**
 * Which slice of the shelf to read. `'unfiled'` is the inbox
 * (`docs/spec-storage-sources.md` §3.2) — arrivals with no edge — and it is a
 * filter on this list rather than a surface of its own, which is why it is a
 * parameter and not a second program.
 */
export type DocumentFiled = 'all' | 'unfiled'

/**
 * Enough extracted text for the toolbar's filter to reach into a document's
 * contents, and not a byte more: the column runs to 2MB. Same 200 as the
 * Files tab and the space Sources lane.
 */
const SNIPPET_CHARS = 200

export const listDocumentsProgram = Effect.fn('listDocumentsProgram')(
  function* (input: {
    filed: DocumentFiled
  }): Effect.fn.Return<Array<ShelfDocument>, DocumentShelfFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: document.entityId,
            filename: document.filename,
            kind: document.kind,
            sizeBytes: document.sizeBytes,
            mime: document.mime,
            extractionStatus: document.extractionStatus,
            extractionError: document.extractionError,
            sourceClass: document.sourceClass,
            sourceCapability: integration.capabilityId,
            sourcePath: document.sourcePath,
            externalUrl: document.externalUrl,
            externalStatus: document.externalStatus,
            uploadedByName: user.name,
            createdAt: document.createdAt,
            snippet: sql<
              string | null
            >`left(${document.extractedText}, ${SNIPPET_CHARS})`,
          })
          .from(document)
          .innerJoin(entity, eq(entity.id, document.entityId))
          // Left on both: `uploaded_by` is null for a document a connector
          // filed with no person behind it, and `source_ref` is null for
          // every manual upload — the `document_source_ref_invariant` check
          // is what makes the second of those exactly the `manual` rows.
          .leftJoin(user, eq(user.id, document.uploadedBy))
          .leftJoin(integration, eq(integration.id, document.sourceRef))
          // A merged-away document stops being a document: it has a
          // survivor, and the shelf would otherwise list both. The inbox
          // rides on the same clause — one statement, two conditions.
          .where(
            input.filed === 'unfiled'
              ? and(isNull(entity.mergedIntoId), unfiledPredicate())
              : isNull(entity.mergedIntoId),
          )
          // Newest first by default. The table's own sort is single-column
          // and client-side; this is what it starts from.
          .orderBy(desc(document.createdAt)),
      catch: (cause) => new DocumentShelfFailed({ cause }),
    })

    if (rows.length === 0) return []

    // Statements two and three. `documentFilingEdges` already drops a
    // merged-away *target* — a chip pointing at a tombstone would route to a
    // page the merge redirects away from.
    const filings = yield* Effect.tryPromise({
      try: () => documentFilingEdges(rows.map((r) => r.id)),
      catch: (cause) => new DocumentShelfFailed({ cause }),
    })

    /** One clock for every row of one read. */
    const now = Date.now()

    return rows.map((r) => {
      const edges = filings.get(r.id) ?? []
      const records: Array<ShelfRecord> = []
      const spaces: Array<ShelfSpace> = []
      for (const edge of edges) {
        if (edge.kind === 'space') spaces.push({ id: edge.id, name: edge.name })
        else
          records.push({
            id: edge.id,
            name: edge.name,
            kind: edge.entityKind,
            objectSlug: edge.objectSlug,
          })
      }
      return {
        id: r.id,
        filename: r.filename ?? 'Untitled file',
        kind: r.kind,
        sizeBytes: r.sizeBytes,
        mime: r.mime,
        extractionStatus: r.extractionStatus,
        extractionError: r.extractionError,
        sourceClass: r.sourceClass,
        sourceCapability: r.sourceCapability,
        sourcePath: r.sourcePath,
        externalUrl: r.externalUrl,
        externalStatus: r.externalStatus,
        uploadedByName: r.uploadedByName,
        createdAt: r.createdAt.toISOString(),
        sinceMs: now - r.createdAt.getTime(),
        snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
        records,
        spaces,
      }
    })
  },
)

/**
 * How many documents are unfiled — Today's badge (SPA-124,
 * `docs/spec-storage-sources.md` §11 delta 6).
 *
 * A count, not the list: the readout wants one number, and the shelf query
 * above folds edges into every row it returns to produce it. Same reason
 * `countOpenInbox` exists beside `listInbox`.
 *
 * The `merged_into_id` exclusion is the shelf's, restated here because it is
 * the same definition of "a document" — a badge counting tombstones would
 * send the reader to a list that does not contain them. The filing half is
 * `unfiledPredicate()` and is written once.
 */
export const countUnfiledProgram = Effect.fn('countUnfiledProgram')(
  function* (): Effect.fn.Return<number, DocumentShelfFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ value: count() })
          .from(document)
          .innerJoin(entity, eq(entity.id, document.entityId))
          .where(and(isNull(entity.mergedIntoId), unfiledPredicate())),
      catch: (cause) => new DocumentShelfFailed({ cause }),
    })
    // `.at(0)` rather than a destructure: an aggregate with no GROUP BY
    // always returns one row, but the type does not say so.
    return rows.at(0)?.value ?? 0
  },
)
