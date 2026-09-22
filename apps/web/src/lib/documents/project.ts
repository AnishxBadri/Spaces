import { DOCUMENT_FIELD_SLUGS } from '#/lib/documents/registry'
import type { ShelfDocument } from '#/lib/documents/shelf'

/**
 * The projection behind the document surface's filter (docsurf-12b,
 * SPA-141): one shelf row → the `Record<string, unknown>` keyed by slug that
 * `matchesConditions` already takes.
 *
 * This is the whole seam. `matchesConditions` reads `values[c.slug]` and
 * knows nothing about where the values came from — on `/companies` they are
 * `entity.values`, here they are columns and edges read into the same shape.
 * The pure filter model (`@spaces/core/views/filter`) gains no branch, no
 * operator and no knowledge that documents exist.
 *
 * Pure and row-at-a-time on purpose: the shelf is unpaged, so the surface
 * filters the rows it already loaded, exactly as every other unpaginated
 * table does. Nothing here touches the database, which is also what lets the
 * projection be tested in `filter.test.ts` style with rows built by hand.
 */

/**
 * The slice of a shelf row the projection reads. A `Pick` rather than the
 * whole `ShelfDocument` so the dependency is exactly the five fields — a
 * column added to the shelf does not silently become a filterable field, and
 * a test can build a row without the other fourteen.
 */
export type ProjectableDocument = Pick<
  ShelfDocument,
  'kind' | 'extractionStatus' | 'sourceClass' | 'records' | 'spaces'
>

/**
 * Values for one row, keyed by `DOCUMENT_FIELD_SLUGS`.
 *
 * The two edge fields project to **arrays of ids**, which is how
 * `matchesCondition` already reads a multi-valued attribute: `is` means "this
 * id is among them" and `is_not` means it is not, so a deck filed against
 * three companies matches a condition naming any one of them. `empty` /
 * `not_empty` fall out of the same array for free.
 *
 * `filed` is the one derived field: true when the row carries a filing edge
 * of **either** kind. It is the same claim `unfiledPredicate()` makes in SQL
 * — absence of edges, never `source_class` and never `blob_sha` — restated
 * over rows the server has already sent. It does not replace `?filed=`: that
 * param is a server-side slice and the readout cell's link target (SPA-124),
 * and this is the client-side condition for a user who wants "unfiled decks"
 * in one saved view.
 */
export function projectDocument(
  r: ProjectableDocument,
): Record<string, unknown> {
  return {
    [DOCUMENT_FIELD_SLUGS.kind]: r.kind,
    [DOCUMENT_FIELD_SLUGS.extraction]: r.extractionStatus,
    [DOCUMENT_FIELD_SLUGS.origin]: r.sourceClass,
    [DOCUMENT_FIELD_SLUGS.space]: r.spaces.map((s) => s.id),
    [DOCUMENT_FIELD_SLUGS.filedAgainst]: r.records.map((x) => x.id),
    [DOCUMENT_FIELD_SLUGS.filed]: r.records.length > 0 || r.spaces.length > 0,
  }
}
