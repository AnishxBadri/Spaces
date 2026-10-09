import { createFileRoute } from '@tanstack/react-router'
import { toGeneral } from '#/lib/settings-moves'

/** General's path before D81; old links land there. */
export const Route = createFileRoute('/_app/settings/workspace')({
  beforeLoad: toGeneral,
})
