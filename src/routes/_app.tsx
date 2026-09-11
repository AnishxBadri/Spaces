import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { AppSidebar } from '#/components/app-sidebar'
import { CommandPalette } from '#/components/command-palette'
import { Wordmark } from '#/components/wordmark'
import { Toaster } from '#/components/ui/sonner'
import { setChassisCollapsed, useChassisCollapsed } from '#/lib/chassis-store'
import { getSession, getWorkspace, listObjects } from '#/lib/server-fns'
import { useHotkey } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/** Authenticated shell: fixed sidebar, fluid content, Cmd-K everywhere. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) throw redirect({ to: '/login' })
    return { session }
  },
  loader: async () => {
    const [workspace, objects] = await Promise.all([
      getWorkspace(),
      listObjects(),
    ])
    return { workspace, objects: objects.filter((o) => !o.isSystem) }
  },
  component: AppShell,
})

function AppShell() {
  const { session } = Route.useRouteContext()
  const { workspace, objects } = Route.useLoaderData()
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const collapsed = useChassisCollapsed()
  const navigate = useNavigate()
  // The keys printed on the chassis: ⌘\ folds it, G , opens Settings.
  useHotkey('mod+\\', () => setChassisCollapsed(!collapsed))
  useHotkey('g ,', () => void navigate({ to: '/settings' }))

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Desktop sidebar */}
      {/* Width snaps, never animates: width is not a compositor property. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 hidden border-r border-sidebar-border md:block',
          collapsed ? 'w-12' : 'w-58',
        )}
      >
        <AppSidebar
          user={session.user}
          workspaceName={workspace?.name ?? null}
          objects={objects}
          onOpenCommand={() => setCommandOpen(true)}
          collapsed={collapsed}
          onToggleCollapsed={() => setChassisCollapsed(!collapsed)}
        />
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-sticky flex h-12 items-center gap-3 border-b border-rule bg-background px-4 md:hidden">
        <button
          type="button"
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((v) => !v)}
          className="focus-ring -ml-1 flex size-8 items-center justify-center rounded-md text-graphite hover:bg-bone"
        >
          {mobileNavOpen ? (
            <X className="size-4.5" strokeWidth={1.75} />
          ) : (
            <Menu className="size-4.5" strokeWidth={1.75} />
          )}
        </button>
        <Wordmark />
      </header>

      {/* Mobile nav drawer */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-dropdown md:hidden">
          <div
            className="absolute inset-0 bg-foreground/20"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 top-12 left-0 w-58 border-r border-sidebar-border shadow-[3px_0_0_0_var(--hairline)]">
            <AppSidebar
              hideWordmark
              user={session.user}
              workspaceName={workspace?.name ?? null}
              objects={objects}
              onOpenCommand={() => {
                setMobileNavOpen(false)
                setCommandOpen(true)
              }}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <main
        className={cn(
          'min-w-0 flex-1 pt-12 md:pt-0',
          collapsed ? 'md:pl-14' : 'md:pl-60',
        )}
      >
        <Outlet />
      </main>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <Toaster position="bottom-right" />
    </div>
  )
}
