import { createFileRoute } from '@tanstack/react-router'
import { filesSearch, toFiles } from '#/lib/documents/to-files'

/** The Files page's path before it was Files; old links land there. */
export const Route = createFileRoute('/_app/documents')({
  validateSearch: filesSearch,
  beforeLoad: toFiles,
})
