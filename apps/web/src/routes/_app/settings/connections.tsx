import { createFileRoute } from '@tanstack/react-router'
import { toEmailCalendar } from '#/lib/settings-moves'

/** Connections' path before accounts were grouped by job; old links land on Email & calendar. */
export const Route = createFileRoute('/_app/settings/connections')({
  beforeLoad: toEmailCalendar,
})
