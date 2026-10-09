import { createFileRoute, redirect } from '@tanstack/react-router'
import { SETTINGS_LANDING } from '#/components/settings/settings-nav'

/**
 * `/settings` is the shell, and a shell with no section in it is an empty
 * page: the index redirects to General, so `G ,` and the ⌘K palette land
 * with the nav already on it. (D81)
 */
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    throw redirect({ to: SETTINGS_LANDING })
  },
})
