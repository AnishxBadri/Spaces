import { createFileRoute } from '@tanstack/react-router'
import { toReview } from '#/lib/inbox/to-review'

/** The review queue's path before it was Review; old bookmarks land there. */
export const Route = createFileRoute('/_app/inbox')({
  beforeLoad: toReview,
})
