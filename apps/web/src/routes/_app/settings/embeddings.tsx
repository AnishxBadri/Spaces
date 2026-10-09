import { createFileRoute } from '@tanstack/react-router'
import { toSearch } from '#/lib/settings-moves'

/** Search's path before D81; old links land there. */
export const Route = createFileRoute('/_app/settings/embeddings')({
  beforeLoad: toSearch,
})
