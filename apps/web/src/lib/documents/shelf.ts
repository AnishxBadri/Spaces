import { Effect, Schema } from 'effect'
import { desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { documentFilingEdges } from '#/lib/server/shared'

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
 * Enough extracted text for the toolbar's filter to reach into a document's
 * contents, and not a byte more: the column runs to 2MB. Same 200 as the
 * Files tab and the space Sources lane.
 */
const SNIPPET_CHARS = 200

export const listDocumentsProgram = Effect.fn('listDocumentsProgram')(
  function* (): Effect.fn.Return<Array<ShelfDocument>, DocumentShelfFailed> {
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
          // survivor, and the shelf would otherwise list both.
          .where(isNull(entity.mergedIntoId))
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
