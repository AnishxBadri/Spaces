import { Link, useNavigate } from '@tanstack/react-router'
import {
  Building2,
  ChevronsUpDown,
  Compass,
  FileText,
  Kanban,
  Layers,
  LogOut,
  Search,
  Settings,
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
  // Mandate first — the fund's identity tops the nav; login still lands on
  // /spaces, where daily work happens (CONTEXT.md, 2026-08).
  { to: '/mandate', label: 'Mandate', icon: Compass },
  { to: '/spaces', label: 'Spaces', icon: Layers },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/people', label: 'People', icon: Users },
  { to: '/deals', label: 'Deals', icon: Kanban },
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
    navigate({ to: '/login' })
  }

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {hideWordmark ? (
        <div className="h-3" />
      ) : (
        <div className="flex h-14 items-center px-4">
          <Link to="/spaces" onClick={onNavigate} aria-label="DealOS home">
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
          className="flex h-8 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 text-[13px] text-muted-foreground transition-colors hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Search className="size-3.5" strokeWidth={1.75} />
          <span>Search…</span>
          <kbd className="ml-auto rounded border border-border bg-muted px-1.5 font-sans text-[10px] leading-4 text-muted-foreground">
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
              'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors',
              'hover:bg-sidebar-accent hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
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
            'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors',
            'hover:bg-sidebar-accent hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
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
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            )}
          >
            {/* Neutral, never the primary — that means action/selection/focus
                only. Opaque ink, not `/80`: the initial is white, and at 80%
                over the sidebar the disc composited to 1.07:1. */}
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-micro font-semibold text-background">
              {user.name.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium leading-tight">
                {user.name}
              </span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
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
