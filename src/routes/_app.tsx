import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { AppSidebar } from '#/components/app-sidebar'
import { CommandPalette } from '#/components/command-palette'
import { Wordmark } from '#/components/wordmark'
import { Toaster } from '#/components/ui/sonner'
import { getSession, getWorkspace } from '#/lib/server-fns'

/** Authenticated shell: fixed sidebar, fluid content, Cmd-K everywhere. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) throw redirect({ to: '/login' })
    return { session }
  },
  loader: async () => ({ workspace: await getWorkspace() }),
  component: AppShell,
})

function AppShell() {
  const { session } = Route.useRouteContext()
  const { workspace } = Route.useLoaderData()
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-sidebar-border md:block">
        <AppSidebar
          user={session.user}
          workspaceName={workspace?.name ?? null}
          onOpenCommand={() => setCommandOpen(true)}
        />
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background px-4 md:hidden">
        <button
          type="button"
          aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen((v) => !v)}
          className="-ml-1 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
        <div className="fixed inset-0 z-20 md:hidden">
          <div
            className="absolute inset-0 bg-foreground/20"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 top-12 w-60 border-r border-sidebar-border shadow-lg">
            <AppSidebar
              hideWordmark
              user={session.user}
              workspaceName={workspace?.name ?? null}
              onOpenCommand={() => {
                setMobileNavOpen(false)
                setCommandOpen(true)
              }}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <main className="min-w-0 flex-1 pt-12 md:pt-0 md:pl-60">
        <Outlet />
      </main>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
      <Toaster position="bottom-right" />
    </div>
  )
}
