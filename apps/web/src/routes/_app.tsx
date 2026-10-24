import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { AppSidebar, CHASSIS_LAYER, NAV_ITEMS } from '#/components/app-sidebar'
import {
  SettingsChassis,
  useSettingsTakeover,
} from '#/components/settings/settings-chassis'
import { KeyboardHelp } from '#/components/keyboard-help'
import { CommandPalette } from '#/components/command-palette'
import { AskDock } from '#/components/ask/ask-dock'
import { toggleAsk } from '#/lib/ask/dock-store'
import { UploadDialog } from '#/components/upload-dialog'
import { ComposeWindows } from '#/components/email/compose-windows'
import { Wordmark } from '#/components/wordmark'
import { Toaster } from '#/components/ui/sonner'
import { setChassisCollapsed, useChassisCollapsed } from '#/lib/chassis-store'
import {
  getSession,
  getWorkspace,
  listDueTaskDays,
  listObjects,
} from '#/lib/server-fns'
import { dueCount } from '#/lib/tasks/due'
import { localToday } from '@spaces/core/tasks/parse-due'
import { useHotkeys } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'

/** Authenticated shell: fixed sidebar, fluid content, Cmd-K and Ask everywhere. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) throw redirect({ to: '/login' })
    return { session }
  },
  loader: async () => {
    // Due days ride the shell's loader, so a task saved anywhere (which
    // invalidates the router) moves the sidebar's count too.
    const [workspace, objects, dueDays] = await Promise.all([
      getWorkspace(),
      listObjects(),
      listDueTaskDays(),
    ])
    return { workspace, objects: objects.filter((o) => !o.isSystem), dueDays }
  },
  component: AppShell,
})

function AppShell() {
  const { session } = Route.useRouteContext()
  const { workspace, objects, dueDays } = Route.useLoaderData()
  const tasksDue = dueCount(dueDays, localToday())
  const [commandOpen, setCommandOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const collapsed = useChassisCollapsed()
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const navigate = useNavigate()
  // Settings takes the chassis over; it never folds to marks.
  const onSettings = useSettingsTakeover()
  const narrow = collapsed && !onSettings
  // The keys printed on the chassis: G-chords go, ⌘\ folds it, ? explains.
  useHotkeys([
    ...NAV_ITEMS.map((item): [string, () => void] => [
      item.key.toLowerCase(),
      () => void navigate({ to: item.to }),
    ]),
    ['g ,', () => void navigate({ to: '/settings' })],
    ['mod+\\', () => setChassisCollapsed(!collapsed)],
    // Ask, docked: opens empty or closes, from anywhere.
    ['mod+j', toggleAsk],
    ['?', () => setKeyboardOpen(true)],
  ])

  return (
    <div className="flex min-h-dvh bg-paper">
      {/* Desktop sidebar */}
      {/* Width snaps, never animates: width is not a compositor property.
          The sidebar draws its own hairline edge, so the current row can
          cross it. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 hidden md:block',
          CHASSIS_LAYER,
          narrow ? 'w-12' : 'w-58',
        )}
      >
        {onSettings ? (
          <SettingsChassis />
        ) : (
          <AppSidebar
            user={session.user}
            workspaceName={workspace?.name ?? null}
            workspaceLogo={workspace?.logo ?? null}
            objects={objects}
            tasksDue={tasksDue}
            onOpenCommand={() => setCommandOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={() => setChassisCollapsed(!collapsed)}
            onOpenKeyboard={() => setKeyboardOpen(true)}
          />
        )}
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-sticky flex h-12 items-center gap-3 border-b border-rule bg-paper px-4 md:hidden">
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
          <div className="absolute inset-y-0 top-12 left-0 w-58 shadow-solid">
            <AppSidebar
              hideWordmark
              user={session.user}
              workspaceName={workspace?.name ?? null}
              workspaceLogo={workspace?.logo ?? null}
              objects={objects}
              tasksDue={tasksDue}
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
          narrow ? 'md:pl-12' : 'md:pl-58',
        )}
      >
        <Outlet />
      </main>

      <AskDock />

      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        objects={objects}
      />
      {/* Mounted once, here: an upload has to outlive the sheet it was
          started from, so closing the dialog leaves in-flight files
          running. */}
      <UploadDialog />
      <ComposeWindows />
      <KeyboardHelp open={keyboardOpen} onOpenChange={setKeyboardOpen} />
      <Toaster position="bottom-right" />
    </div>
  )
}
