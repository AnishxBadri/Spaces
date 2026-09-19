import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * `/dedupe` was the duplicate queue until SPA-76 generalized it into the
 * review inbox. The path stays reachable permanently — it is in the browser
 * history of everyone who used the app before the rename, and a bookmark is
 * not a reason to make a surface answer twice.
 */
export const Route = createFileRoute('/_app/dedupe')({
  beforeLoad: () => {
    // 301, not the 307 default: the move is a decision, not a condition, and
    // `RESERVED` holds both `dedupe` and `inbox` so no object can ever claim
    // the old path back. `replace` keeps it out of the back stack.
    throw redirect({ to: '/inbox', statusCode: 301, replace: true })
  },
})
