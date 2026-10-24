import { createFileRoute } from '@tanstack/react-router'
import { toGeneral } from '#/lib/settings-moves'

/** General's old path; old links land there. */
export const Route = createFileRoute('/_app/settings/workspace')({
  beforeLoad: toGeneral,
})
