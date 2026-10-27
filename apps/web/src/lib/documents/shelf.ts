import { excerpt } from '@spaces/core/context/excerpt'
import { Effect, Schema } from 'effect'
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { document, entity, integration } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { documentFilingEdges } from '#/lib/server/shared'
import { unfiledPredicate } from '#/lib/documents/unfiled'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'

/**
 * The shelf behind `/documents`: every document in the workspace as one row,
 * with the filing resolved. `listRecordDocuments` answers one row per filing;
 * this starts at `document` and folds the edges in.
 * - Three statements, by design, not 2N+1: the documents, then
 *   `documentFilingEdges` for links and spaces (the Files tab's reader too;
 *   never add a second edge reader).
 * - `sourceCapability` and the `filed` filter ride on statement one; the
 *   unfiled inbox is `unfiledPredicate()`, shared with Today's count.
 * - Outside the server-fn modules, whose plain exports ship to the browser.
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
  /**
   * The two columns that say whether this row has a file behind it or only
   * an address. `blobSha` is null on a clipped article — the
   * page was read, never stored — and `url` is set on the clips and on
   * captures, which keep the page's text as a blob too. The shelf
   * reads the pair to offer "Open source" wherever there is a page, and never
   * a download where there are no bytes.
   */
  blobSha: string | null
  url: string | null
  sourceClass: (typeof document.$inferSelect)['sourceClass']
  /** The integration that filed it, named; null for a manual upload. */
  sourceCapability: string | null
  /**
   * The three storage-source columns the Source column reads. All null until
   * a storage-source plugin files the document, and a null path renders the
   * origin on its own, not an empty cell.
   * `external_id` and `connection_id` are left out: they are the sync's
   * idempotency key, nothing a reader sees.
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
 * — arrivals with no edge — and it is a
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
    /** Whose shelf: a document private to someone else is not on it. */
    viewer: { id: string }
  }): Effect.fn.Return<Array<ShelfDocument>, DocumentShelfFailed> {
    const visible = canReadDocumentSql(input.viewer.id)
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
            blobSha: document.blobSha,
            url: document.url,
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
          // A private email attachment is off every viewer's shelf but its
          // reader's.
          .where(
            input.filed === 'unfiled'
              ? and(isNull(entity.mergedIntoId), unfiledPredicate(), visible)
              : and(isNull(entity.mergedIntoId), visible),
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
        blobSha: r.blobSha,
        url: r.url,
        sourceClass: r.sourceClass,
        sourceCapability: r.sourceCapability,
        sourcePath: r.sourcePath,
        externalUrl: r.externalUrl,
        externalStatus: r.externalStatus,
        uploadedByName: r.uploadedByName,
        createdAt: r.createdAt.toISOString(),
        sinceMs: now - r.createdAt.getTime(),
        snippet: excerpt(r.snippet ?? '') || null,
        records,
        spaces,
      }
    })
  },
)

/**
 * How many documents are unfiled — Today's badge.
 *
 * A count, not the list: the readout wants one number, and the shelf query
 * above folds edges into every row it returns to produce it.
 *
 * The `merged_into_id` exclusion is the shelf's, restated here because it is
 * the same definition of "a document" — a badge counting tombstones would
 * send the reader to a list that does not contain them. The filing half is
 * `unfiledPredicate()` and is written once.
 */
export const countUnfiledProgram = Effect.fn('countUnfiledProgram')(
  function* (viewer: {
    id: string
  }): Effect.fn.Return<number, DocumentShelfFailed> {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ value: count() })
          .from(document)
          .innerJoin(entity, eq(entity.id, document.entityId))
          .where(
            and(
              isNull(entity.mergedIntoId),
              unfiledPredicate(),
              canReadDocumentSql(viewer.id),
            ),
          ),
      catch: (cause) => new DocumentShelfFailed({ cause }),
    })
    // `.at(0)` rather than a destructure: an aggregate with no GROUP BY
    // always returns one row, but the type does not say so.
    return rows.at(0)?.value ?? 0
  },
)

/**
 * The shelf's two tab counts, whichever tab is open: every document the
 * viewer may read, and the unfiled ones (`countUnfiledProgram`, Today's
 * badge, so the tab and the badge cannot disagree).
 */
export const shelfCountsProgram = Effect.fn('shelfCountsProgram')(
  function* (viewer: {
    id: string
  }): Effect.fn.Return<{ all: number; unfiled: number }, DocumentShelfFailed> {
    const [all, unfiled] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () =>
            db
              .select({ value: count() })
              .from(document)
              .innerJoin(entity, eq(entity.id, document.entityId))
              .where(
                and(isNull(entity.mergedIntoId), canReadDocumentSql(viewer.id)),
              ),
          catch: (cause) => new DocumentShelfFailed({ cause }),
        }),
        countUnfiledProgram(viewer),
      ],
      { concurrency: 'unbounded' },
    )
    return { all: all.at(0)?.value ?? 0, unfiled }
  },
)
