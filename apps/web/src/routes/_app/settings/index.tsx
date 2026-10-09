import { createFileRoute, redirect } from '@tanstack/react-router'
import { FIRST_SETTINGS_SECTION } from '#/components/settings/settings-nav'

/**
 * `/settings` is the shell, and a shell with no section in it is an empty
 * page: the index redirects to the first row of `SETTINGS_SECTIONS`, so `G ,`
 * and the ⌘K palette land with the nav already on it.
 */
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    throw redirect({ to: FIRST_SETTINGS_SECTION.to })
  },
})
