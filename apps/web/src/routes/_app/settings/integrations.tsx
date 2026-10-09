import { createFileRoute } from '@tanstack/react-router'
import { toPlugins } from '#/lib/settings-moves'

/** Plugins' path before D81; old links land there. */
export const Route = createFileRoute('/_app/settings/integrations')({
  beforeLoad: toPlugins,
})
