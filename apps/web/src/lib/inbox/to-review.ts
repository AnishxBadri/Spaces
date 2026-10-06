import { redirect } from '@tanstack/react-router'

/**
 * The `beforeLoad` of every old path of the review queue (`/inbox`,
 * `/dedupe`): one permanent redirect straight to `/review`, never through
 * another old path, so a bookmark never walks a chain. (D61)
 *
 * - 301, not the 307 default: the move is a decision, not a condition.
 * - `RESERVED` keeps each old path, so no object can claim it back.
 * - `replace` keeps the old path out of the back stack.
 */
export function toReview(): never {
  throw redirect({ to: '/review', statusCode: 301, replace: true })
}
