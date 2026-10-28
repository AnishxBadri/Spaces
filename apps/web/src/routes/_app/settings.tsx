import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router'
import { useSettingsNav } from '#/components/settings/settings-chassis'
import { SettingsForm } from '#/components/settings/settings-form'
import { SettingsNav, sectionAt } from '#/components/settings/settings-nav'
import { SettingsPageProvider } from '#/components/settings/settings-section'
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
 * - The page form and its Save bar live here, one per page; a member on an
 *   admin-only row reads the page with its controls disabled.
 */
export const Route = createFileRoute('/_app/settings')({
  loader: async () => {
    const [session, workspace, members, templates, objects, fx, integrations] =
      await Promise.all([
        getSession(),
        getWorkspace(),
        listMembers(),
        listTemplates({ data: { includeArchived: true } }),
        listObjects({ data: { includeArchived: true } }),
        listFxRates(),
        countIntegrations(),
      ])
    const isAdmin = session?.user.role === 'admin'
    const invites = isAdmin ? await listInvites() : []
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
  const { isAdmin, counts, admins } = useSettingsNav()
  const { pathname } = useLocation()
  const adminOnly = sectionAt(pathname)?.admin === true

  // One head per page: the section is the page, so the shell draws no title.
  return (
    <SettingsPageProvider value={{ isAdmin, adminOnly, admins }}>
      <div className="flex min-h-full flex-col">
        <SettingsForm>
          <div className="md:hidden">
            <SettingsNav variant="strip" counts={counts} isAdmin={isAdmin} />
          </div>
          {/* A 700px column inside the gutters (the Save bar matches it); the
              foot clears the bar, so it never covers the last row. */}
          <div className="box-content flex max-w-[43.75rem] flex-col gap-12 px-8 pt-7 pb-20">
            <Outlet />
          </div>
        </SettingsForm>
      </div>
    </SettingsPageProvider>
  )
}
