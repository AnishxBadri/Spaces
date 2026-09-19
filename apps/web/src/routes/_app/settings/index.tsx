import { createFileRoute, redirect } from '@tanstack/react-router'
import { FIRST_SETTINGS_SECTION } from '#/components/settings/settings-nav'

/**
 * `/settings` is the shell, and a shell with no section in it is an empty
 * page. The index redirects to the first row of `SETTINGS_SECTIONS` — so
 * every link that still points at `/settings` (the account menu's `G ,`,
 * the ⌘K palette) lands on Workspace with the nav already on it.
 */
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    throw redirect({ to: FIRST_SETTINGS_SECTION.to })
  },
})
