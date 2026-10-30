import { createFileRoute } from '@tanstack/react-router'
import { toConnections } from '#/lib/settings-moves'

/** Connection apps folded into Connections; old links land there. */
export const Route = createFileRoute('/_app/settings/connection-apps')({
  beforeLoad: toConnections,
})
