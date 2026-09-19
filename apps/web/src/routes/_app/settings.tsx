import { createFileRoute, Outlet } from '@tanstack/react-router'
import { PageHeader } from '#/components/page-header'
import { SettingsNav } from '#/components/settings/settings-nav'
import {
  getSession,
  getWorkspace,
  listInvites,
  listMembers,
  listFxRates,
  listObjects,
  listTemplates,
} from '#/lib/server-fns'

/**
 * Settings: the shell (SPA-26). The workspace singleton, members + invites,
 * templates, currency and the attribute registries are five child routes
 * under this layout — `routes/_app/settings/<name>.tsx` — and the eleven
 * pending sections are the sixth through sixteenth. The nav grammar they
 * join is `components/settings/settings-nav.tsx`; the shape they take is
 * `SettingsSection`. Structure fixed, content free; admin owns the
 * destructive edges.
 *
 * The loader stays whole here because the header's readout counts all five
 * sections — one round of queries for the shell, not one per section. A
 * section that needs data no readout counts loads it in its own child
 * route's loader.
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
    const invites = isAdmin ? await listInvites() : []
    return {
      me: session!.user,
      isAdmin,
      workspace,
      members,
      templates,
      invites,
      objects,
      fx,
    }
  },
  component: SettingsShell,
})

function SettingsShell() {
  const data = Route.useLoaderData()

  return (
    <div className="flex min-h-full flex-col">
      <PageHeader
        title="Settings"
        description={
          <>
            <span>workspace</span>
            <span>{data.members.length} members</span>
            <span>{data.templates.length} templates</span>
            <span>{data.fx.rates.length} fx rates</span>
            <span>{data.objects.length} objects</span>
            <span>{data.isAdmin ? 'admin' : 'member'}</span>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SettingsNav isAdmin={data.isAdmin} />
        <div className="flex w-full max-w-[56.25rem] flex-col gap-12 px-8 py-8">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
