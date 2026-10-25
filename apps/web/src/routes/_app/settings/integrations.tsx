import { createFileRoute } from '@tanstack/react-router'
import { toPlugins } from '#/lib/settings-moves'

/** Plugins' old path; old links land there. */
export const Route = createFileRoute('/_app/settings/integrations')({
  beforeLoad: toPlugins,
})
