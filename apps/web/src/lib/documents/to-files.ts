import { redirect } from '@tanstack/react-router'
import { Schema } from 'effect'
import { fallback, searchValidator } from '#/lib/search-validator'

/**
 * The search of the Files page, shared with `/documents` so a redirect
 * carries it whole.
 *
 * - A fallback, not a bare default: a hand-typed `?filed=nonsense` lands on
 *   the list, not on an error boundary.
 */
const FilesSearch = Schema.Struct({
  filed: fallback(Schema.Literals(['all', 'unfiled']), 'all'),
  view: Schema.optional(Schema.String),
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
