import { createFileRoute } from '@tanstack/react-router'
import { toReview } from '#/lib/inbox/to-review'

/** The duplicate queue's path before Review took both lanes. */
export const Route = createFileRoute('/_app/dedupe')({
  beforeLoad: toReview,
})
