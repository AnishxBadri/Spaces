import { redirect } from '@tanstack/react-router'
import { Schema } from 'effect'
import { DOCUMENT_KINDS } from '@spaces/core/documents'
import { caught, fallback, searchValidator } from '#/lib/search-validator'

/**
 * The search of the Files page, shared with `/documents` so a redirect
 * carries it whole.
 *
 * - A fallback, not a bare default: a hand-typed `?filed=nonsense` lands on
 *   the list, not on an error boundary.
 * - `filed=unfiled` is kept so old links land: the page opens on `All`,
 *   whose first band is `Unfiled`.
 * - `tab` is the kind tab, `q` the search and `n` how many rows are shown;
 *   each is absent at its default, so the plain address stays `/files`.
 */
const FilesSearch = Schema.Struct({
  filed: fallback(Schema.Literals(['all', 'unfiled']), 'all'),
  view: Schema.optional(Schema.String),
  tab: caught(Schema.Literals(DOCUMENT_KINDS)),
  q: caught(Schema.String.check(Schema.isMaxLength(200))),
  n: caught(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export const filesSearch = searchValidator(FilesSearch)

export type FilesSearch = typeof FilesSearch.Type

/**
 * The `beforeLoad` of `/documents`: one permanent redirect to `/files`, query
 * intact, so `?filed=unfiled` links and bookmarks land on the same filtered
 * list.
 *
 * - 301, not the 307 default: the rename is a decision, not a condition.
 * - `replace` keeps the old path out of the back stack.
 */
export function toFiles({ search }: { search: FilesSearch }): never {
  throw redirect({ to: '/files', search, statusCode: 301, replace: true })
}
