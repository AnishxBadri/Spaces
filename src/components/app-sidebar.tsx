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
  Sunrise,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Mark, Wordmark } from './wordmark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { authClient } from '#/lib/auth-client'
import { objectIcon } from '#/lib/object-icons'
import { cn } from '#/lib/utils'

/**
 * The chassis (Instrument, 2026-09-10). 232px of bone with a hairline right
 * edge. Three groups: the work (Today, Tasks, Spaces, Notes), the objects
 * (Companies, People, Deals, then customs), capital (Portfolio, Mandate).
 * Rows are 30px with a 14px mark slot so every label sits on one lane.
 * Current page = paper + rule border + medium weight — never a pine bar
 * (the No-Bar Rule). Settings and the user are pinned to the foot.
 */
export const NAV_ITEMS = [
  // Today first and login lands there (2026-08-08): the attention page is
  // the notification channel in a self-hosted product.
  { to: '/today', label: 'Today', icon: Sunrise },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/spaces', label: 'Spaces', icon: Layers },
  { to: '/notes', label: 'Notes', icon: FileText },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/people', label: 'People', icon: Users },
  { to: '/deals', label: 'Deals', icon: Kanban },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { to: '/mandate', label: 'Mandate', icon: Compass },
] as const

const WORK = NAV_ITEMS.slice(0, 4)
const OBJECTS = NAV_ITEMS.slice(4, 7)
const CAPITAL = NAV_ITEMS.slice(7)

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

export function AppSidebar({
  user,
  workspaceName,
  objects = [],
  onOpenCommand,
  onNavigate,
  hideWordmark = false,
}: {
  user: { name: string; email: string }
  /** The workspace singleton's name — the deployment's identity. */
  workspaceName?: string | null
  /** Custom objects (spec §9) — they join the nav right after Deals. */
  objects?: Array<{ slug: string; plural: string; icon: string | null }>
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
    <div className="flex h-full flex-col justify-between bg-sidebar">
      <div className="flex flex-col">
        {hideWordmark ? (
          <div className="h-2" />
        ) : (
          <div className="flex h-12 items-center justify-between border-b border-hairline px-4">
            <Link
              to="/spaces"
              onClick={onNavigate}
              className="focus-ring"
              // Accessible name must contain the visible text (WCAG 2.5.3).
              aria-label={
                workspaceName ? `${workspaceName} home` : 'DealOS home'
              }
            >
              <Wordmark />
            </Link>
            {workspaceName ? (
              <span className="truncate mono text-micro text-graphite">
                {workspaceName}
              </span>
            ) : null}
          </div>
        )}

        <div className="px-3 pt-3 pb-1">
          <button
            type="button"
            onClick={onOpenCommand}
            className="focus-ring flex h-8 w-full items-center justify-between rounded-md border border-rule bg-paper px-2.5 text-ui text-graphite transition-colors hover:border-hairline"
          >
            <span>Search or jump to…</span>
            <kbd className="mono text-micro text-graphite">
              {isMac ? '⌘K' : 'Ctrl K'}
            </kbd>
          </button>
        </div>

        <nav className="flex flex-col px-3 pt-2" aria-label="Primary">
          <NavGroup>
            {WORK.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                icon={item.icon}
                onClick={onNavigate}
              >
                {item.label}
              </NavLink>
            ))}
          </NavGroup>

          <NavGroup label="Objects">
            {OBJECTS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                icon={item.icon}
                onClick={onNavigate}
              >
                {item.label}
              </NavLink>
            ))}
            {objects.map((o) => (
              <NavLink
                key={`o:${o.slug}`}
                to="/o/$objectSlug"
                params={{ objectSlug: o.slug }}
                icon={objectIcon(o)}
                onClick={onNavigate}
              >
                {o.plural}
              </NavLink>
            ))}
          </NavGroup>

          <NavGroup label="Capital">
            {CAPITAL.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                icon={item.icon}
                onClick={onNavigate}
              >
                {item.label}
              </NavLink>
            ))}
          </NavGroup>
        </nav>
      </div>

      <div className="border-t border-rule">
        <Link
          to="/settings"
          onClick={onNavigate}
          className={cn(
            'flex h-[1.875rem] items-center justify-between px-5 text-ui text-foreground transition-colors',
            'hover:bg-bone-deep',
            'focus-ring-inset',
          )}
          activeProps={{
            className: 'font-medium',
            'aria-current': 'page',
          }}
        >
          Settings
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'flex h-12 w-full items-center gap-2.5 border-t border-rule px-4 text-left transition-colors',
              'hover:bg-bone-deep',
              'focus-ring-inset',
            )}
          >
            {/* Ink square, never the primary: a mark, not a status. */}
            <span className="flex size-[1.375rem] shrink-0 items-center justify-center bg-foreground mono text-[0.625rem] font-medium text-background">
              {initials(user.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui leading-tight font-medium">
                {user.name}
              </span>
              <span className="block truncate mono text-micro leading-tight text-graphite">
                {user.email}
              </span>
            </span>
            <ChevronsUpDown
              className="size-3.5 shrink-0 text-graphite"
              strokeWidth={1.75}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuLabel className="mono text-micro text-graphite">
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.charAt(0) ?? ''
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? '') : ''
  return (first + last).toUpperCase()
}

function NavGroup({
  label,
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-0.5', label && 'pt-5')}>
      {label ? (
        <div className="flex h-6 items-center px-2.5">
          <span className="label-caps text-[0.625rem] text-graphite">
            {label}
          </span>
        </div>
      ) : null}
      {children}
    </div>
  )
}

function NavLink({
  to,
  params,
  icon: Icon,
  onClick,
  children,
}: {
  to: string
  params?: Record<string, string>
  icon: LucideIcon
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      params={params}
      onClick={onClick}
      className={cn(
        'flex h-[1.875rem] items-center gap-2.5 rounded-md border border-transparent px-2.5 text-ui text-foreground transition-colors',
        'hover:bg-bone-deep',
        'focus-ring',
      )}
      activeProps={{
        className: 'border-rule bg-paper font-medium hover:bg-paper',
        'aria-current': 'page',
      }}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{children}</span>
    </Link>
  )
}

// Mark is re-exported for the mobile top bar, which shows it alone.
export { Mark }
