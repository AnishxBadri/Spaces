import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useSettingsNav } from '#/components/settings/settings-chassis'
import { SettingsNav } from '#/components/settings/settings-nav'
import {
  getSession,
  countIntegrations,
  getWorkspace,
  listInvites,
  listMembers,
  listFxRates,
  listObjects,
  listTemplates,
} from '#/lib/server-fns'

/**
 * Settings: the shell. Every section is a child route under this layout,
 * joining the nav by one row of `SETTINGS_SECTIONS` and taking the
 * `SettingsSection` shape.
 * - At `md` and up the nav is the chassis (`SettingsChassis`, drawn by the
 *   app shell in place of the app nav); below it, a strip above the content.
 * - The loader stays whole here because the nav's right lane counts five of
 *   the sections — one round of queries for the shell, not one per section.
 */
export const Route = createFileRoute('/_app/settings')({
  loader: async () => {
    const [session, workspace, members, templates, objects, fx] =
      await Promise.all([
        getSession(),
        getWorkspace(),
        listMembers(),
        listTemplates({ data: { includeArchived: true } }),
        listObjects({ data: { includeArchived: true } }),
        listFxRates(),
      ])
    const isAdmin = session?.user.role === 'admin'
    const [invites, integrations] = isAdmin
      ? await Promise.all([listInvites(), countIntegrations()])
      : [[], null]
    return {
      me: session!.user,
      isAdmin,
      workspace,
      members,
      templates,
      invites,
      integrations,
      objects,
      fx,
    }
  },
  component: SettingsShell,
})

function SettingsShell() {
  const { isAdmin, counts } = useSettingsNav()

  // One head per page: the section is the page, so the shell draws no title.
  return (
    <div className="flex min-h-full flex-col">
      <div className="md:hidden">
        <SettingsNav variant="strip" isAdmin={isAdmin} counts={counts} />
      </div>
      <div className="flex w-full max-w-[56.25rem] flex-col gap-12 px-8 pt-7 pb-8">
        <Outlet />
      </div>
    </div>
  )
}
