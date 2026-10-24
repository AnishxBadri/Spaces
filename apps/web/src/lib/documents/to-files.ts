import { redirect } from '@tanstack/react-router'
import { z } from 'zod'

/**
 * The search of the Files page, shared with `/documents` so a redirect
 * carries it whole.
 *
 * - `.catch('all')`, not a bare default: a hand-typed `?filed=nonsense`
 *   lands on the list, not on an error boundary.
 */
export const filesSearch = z.object({
  filed: z.enum(['all', 'unfiled']).catch('all').default('all'),
  view: z.string().optional(),
})

export type FilesSearch = z.infer<typeof filesSearch>

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
