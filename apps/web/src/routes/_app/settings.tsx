import { createFileRoute, Outlet } from '@tanstack/react-router'
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
 * The loader stays whole here because the nav's right lane counts four of
 * the sections — one round of queries for the shell, not one per section. A
 * section that needs data no count reads loads it in its own child route's
 * loader.
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

  // One head per page (2026-09-30): the section is the page, so the shell
  // draws no title of its own. What the old readout line counted now sits
  // in the nav rows' right lane, the way the chassis prints a count.
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <SettingsNav
        isAdmin={data.isAdmin}
        counts={{
          '/settings/members': data.members.length,
          '/settings/templates': data.templates.length,
          '/settings/objects': data.objects.length,
          '/settings/currency': data.fx.rates.length,
        }}
      />
      <div className="flex w-full max-w-[56.25rem] flex-col gap-12 px-8 pt-7 pb-8">
        <Outlet />
      </div>
    </div>
  )
}
