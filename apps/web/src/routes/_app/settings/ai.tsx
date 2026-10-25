import { createFileRoute } from '@tanstack/react-router'
import { toModels } from '#/lib/settings-moves'

/** Models' old path; old links land there. */
export const Route = createFileRoute('/_app/settings/ai')({
  beforeLoad: toModels,
})
