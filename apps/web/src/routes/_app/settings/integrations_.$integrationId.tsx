import { createFileRoute } from '@tanstack/react-router'
import { toPlugin } from '#/lib/settings-moves'

/** One plugin's path before D81; old links land on its page. */
export const Route = createFileRoute(
  '/_app/settings/integrations_/$integrationId',
)({
  beforeLoad: toPlugin,
})
