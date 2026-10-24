import { createFileRoute } from '@tanstack/react-router'
import { toSearch } from '#/lib/settings-moves'

/** Search's old path; old links land there. */
export const Route = createFileRoute('/_app/settings/embeddings')({
  beforeLoad: toSearch,
})
