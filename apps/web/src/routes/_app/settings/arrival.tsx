import { createFileRoute } from '@tanstack/react-router'
import { toEmailForwarding } from '#/lib/settings-moves'

/** Email forwarding's path before D81; old links land there. */
export const Route = createFileRoute('/_app/settings/arrival')({
  beforeLoad: toEmailForwarding,
})
