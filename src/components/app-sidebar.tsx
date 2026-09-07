import { Link, useNavigate } from '@tanstack/react-router'
import {
  Briefcase,
  Building2,
  CheckSquare,
  ChevronsUpDown,
  Compass,
  FileText,
  Kanban,
  Layers,
  LogOut,
  Search,
  Settings,
  Sunrise,
  Users,
} from 'lucide-react'
import { Wordmark } from './wordmark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { authClient } from '#/lib/auth-client'
import { cn } from '#/lib/utils'

export const NAV_ITEMS = [
  // Today first and login lands there (2026-08-08): the attention page is
  // the notification channel in a self-hosted product. Mandate follows —
  // the fund's identity still tops the object nav.
  { to: '/today', label: 'Today', icon: Sunrise },
  { to: '/mandate', label: 'Mandate', icon: Compass },
  { to: '/spaces', label: 'Spaces', icon: Layers },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/people', label: 'People', icon: Users },
  { to: '/deals', label: 'Deals', icon: Kanban },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/notes', label: 'Notes', icon: FileText },
] as const

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

export function AppSidebar({
  user,
  workspaceName,
  onOpenCommand,
  onNavigate,
  hideWordmark = false,
}: {
  user: { name: string; email: string }
  /** The workspace singleton's name — the deployment's identity. */
  workspaceName?: string | null
  onOpenCommand: () => void
  onNavigate?: () => void
  /** Drawer usage — the mobile top bar already shows the wordmark. */
  hideWordmark?: boolean
}) {
  const navigate = useNavigate()

  async function signOut() {
    await authClient.signOut()
    void navigate({ to: '/login' })
  }

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {hideWordmark ? (
        <div className="h-3" />
      ) : (
        <div className="flex h-14 items-center px-4">
          <Link
            to="/spaces"
            onClick={onNavigate}
            // Accessible name must contain the visible text (WCAG 2.5.3) —
            // hard-coding the product name breaks voice control the moment
            // the workspace has its own.
            aria-label={workspaceName ? `${workspaceName} home` : 'DealOS home'}
          >
            {workspaceName ? (
              <span className="block truncate text-title font-semibold tracking-tight">
                {workspaceName}
              </span>
            ) : (
              <Wordmark />
            )}
          </Link>
        </div>
      )}

      <div className="px-3">
        <button
          type="button"
          onClick={onOpenCommand}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 text-ui text-muted-foreground focus-ring transition-colors hover:border-input"
        >
          <Search className="size-3.5" strokeWidth={1.75} />
          <span>Search…</span>
          <kbd className="ml-auto rounded border border-border bg-muted px-1.5 font-sans text-micro leading-4 text-muted-foreground">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>

      <nav className="mt-4 flex-1 space-y-0.5 px-3" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors',
              'hover:bg-sidebar-accent hover:text-foreground',
              'focus-ring',
            )}
            activeProps={{
              className: 'bg-selected text-foreground',
              'aria-current': 'page',
            }}
          >
            <item.icon className="size-4" strokeWidth={1.75} />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="space-y-0.5 border-t border-sidebar-border p-3">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={cn(
            'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-ui font-medium text-muted-foreground transition-colors',
            'hover:bg-sidebar-accent hover:text-foreground',
            'focus-ring',
          )}
          activeProps={{
            className: 'bg-selected text-foreground',
            'aria-current': 'page',
          }}
        >
          <Settings className="size-4" strokeWidth={1.75} />
          Settings
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors',
              'hover:bg-sidebar-accent',
              'focus-ring',
            )}
          >
            {/* Neutral, never the primary — that means action/selection/focus
                only. Opaque ink, not `/80`: the initial is white, and at 80%
                over the sidebar the disc composited to 1.07:1. */}
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-micro font-semibold text-background">
              {user.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui leading-tight font-medium">
                {user.name}
              </span>
              <span className="block truncate text-micro leading-tight text-muted-foreground">
                {user.email}
              </span>
            </span>
            <ChevronsUpDown
              className="size-3.5 shrink-0 text-muted-foreground"
              strokeWidth={1.75}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Signed in as {user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut} variant="destructive">
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
