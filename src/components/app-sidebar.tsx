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
  Keyboard,
  LogOut,
  Settings,
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
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
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
 *
 * The head row ends on a mono `«` that folds the chassis (⌘\); collapsed,
 * it is 48px of marks only — the current page a paper box, names as ink
 * tooltips, the mark at the top the way back out. The foot is one account
 * row whose menu opens to the right and holds Settings (G ,) and Sign out.
 */
export const NAV_ITEMS = [
  // Today first and login lands there (2026-08-08): the attention page is
  // the notification channel in a self-hosted product.
  // `key` is the G-chord printed in the row's right lane; the shell binds
  // it (useHotkeys) and the keyboard sheet lists it. Portfolio takes F
  // (fund) because People has P.
  { to: '/today', label: 'Today', icon: Sunrise, key: 'G T' },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, key: 'G K' },
  { to: '/spaces', label: 'Spaces', icon: Layers, key: 'G S' },
  { to: '/notes', label: 'Notes', icon: FileText, key: 'G N' },
  { to: '/companies', label: 'Companies', icon: Building2, key: 'G C' },
  { to: '/people', label: 'People', icon: Users, key: 'G P' },
  { to: '/deals', label: 'Deals', icon: Kanban, key: 'G D' },
  { to: '/portfolio', label: 'Portfolio', icon: Briefcase, key: 'G F' },
  { to: '/mandate', label: 'Mandate', icon: Compass, key: 'G M' },
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
  collapsed = false,
  onToggleCollapsed,
  onOpenKeyboard,
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
  /** The 48px marks-only chassis. */
  collapsed?: boolean
  /** Present on the desktop chassis only; the drawer never collapses. */
  onToggleCollapsed?: () => void
  /** Opens the keyboard sheet (also on `?`). */
  onOpenKeyboard?: () => void
}) {
  const navigate = useNavigate()

  async function signOut() {
    await authClient.signOut()
    void navigate({ to: '/login' })
  }

  if (collapsed) {
    return (
      <CollapsedSidebar
        user={user}
        workspaceName={workspaceName}
        objects={objects}
        onOpenCommand={onOpenCommand}
        onExpand={onToggleCollapsed}
        onKeyboard={onOpenKeyboard}
        onSignOut={signOut}
      />
    )
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
                workspaceName ? `${workspaceName} home` : 'Spaces home'
              }
            >
              <Wordmark />
            </Link>
            <span className="flex min-w-0 items-center gap-2">
              {workspaceName ? (
                <span className="truncate mono text-micro text-graphite">
                  {workspaceName}
                </span>
              ) : null}
              {onToggleCollapsed ? (
                <IconTip label="Collapse sidebar · ⌘\\">
                  <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-label="Collapse sidebar"
                    className="focus-ring -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md mono text-label text-graphite transition-colors hover:bg-bone-deep hover:text-foreground"
                  >
                    «
                  </button>
                </IconTip>
              ) : null}
            </span>
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
                hint={item.key}
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
                hint={item.key}
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
                hint={item.key}
                onClick={onNavigate}
              >
                {item.label}
              </NavLink>
            ))}
          </NavGroup>
        </nav>
      </div>

      <div className="border-t border-rule">
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
          <AccountMenu
            email={user.email}
            onNavigate={onNavigate}
            onKeyboard={onOpenKeyboard}
            onSignOut={signOut}
          />
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * The account menu opens to the right of the chassis, never up into the
 * screen corner. It holds everything about the session: Settings, sign out.
 */
function AccountMenu({
  email,
  onNavigate,
  onKeyboard,
  onSignOut,
}: {
  email: string
  onNavigate?: () => void
  onKeyboard?: () => void
  onSignOut: () => void
}) {
  const navigate = useNavigate()
  return (
    <DropdownMenuContent
      side="right"
      align="end"
      sideOffset={8}
      className="w-56"
    >
      <DropdownMenuLabel className="mono text-micro text-graphite">
        Signed in as {email}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          onNavigate?.()
          void navigate({ to: '/settings' })
        }}
      >
        <Settings className="size-4" />
        Settings
        <span className="ml-auto mono text-micro text-graphite">G ,</span>
      </DropdownMenuItem>
      {onKeyboard ? (
        <DropdownMenuItem onSelect={onKeyboard}>
          <Keyboard className="size-4" />
          Keyboard
          <span className="ml-auto mono text-micro text-graphite">?</span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onSignOut}>
        <LogOut className="size-4" />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

/**
 * The collapsed chassis (Rails sheet, "chassis · collapsed 48"): a 48px cell
 * with the mark on a hairline, ⌘K on a rule, 36px rows of 14px marks with a
 * 24px rule between groups, the current page in a 36×32 paper box; the foot
 * is Settings, `›`, and the ink initials square.
 */
function CollapsedSidebar({
  user,
  workspaceName,
  objects,
  onOpenCommand,
  onExpand,
  onKeyboard,
  onSignOut,
}: {
  user: { name: string; email: string }
  workspaceName?: string | null
  objects: Array<{ slug: string; plural: string; icon: string | null }>
  onOpenCommand: () => void
  onExpand?: () => void
  onKeyboard?: () => void
  onSignOut: () => void
}) {
  return (
    <div className="flex h-full flex-col justify-between bg-sidebar">
      <div className="flex flex-col items-center">
        <IconTip
          label={`Expand sidebar · ⌘\\${workspaceName ? ` · ${workspaceName}` : ''}`}
        >
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand sidebar"
            className="focus-ring-inset flex h-12 w-12 items-center justify-center border-b border-hairline transition-colors hover:bg-bone-deep"
          >
            <Mark className="text-foreground" />
          </button>
        </IconTip>
        <IconTip label="Search or jump to…">
          <button
            type="button"
            onClick={onOpenCommand}
            aria-label="Search or jump to"
            className="focus-ring-inset flex h-10 w-12 items-center justify-center border-b border-rule mono text-micro text-graphite transition-colors hover:text-foreground"
          >
            {isMac ? '⌘K' : 'Ctrl K'}
          </button>
        </IconTip>

        <nav className="flex flex-col items-center pt-1.5" aria-label="Primary">
          {WORK.map((item) => (
            <CollapsedNavLink key={item.to} to={item.to} icon={item.icon}>
              {item.label}
            </CollapsedNavLink>
          ))}
          <GroupRule />
          {OBJECTS.map((item) => (
            <CollapsedNavLink key={item.to} to={item.to} icon={item.icon}>
              {item.label}
            </CollapsedNavLink>
          ))}
          {objects.map((o) => (
            <CollapsedNavLink
              key={`o:${o.slug}`}
              to="/o/$objectSlug"
              params={{ objectSlug: o.slug }}
              icon={objectIcon(o)}
            >
              {o.plural}
            </CollapsedNavLink>
          ))}
          <GroupRule />
          {CAPITAL.map((item) => (
            <CollapsedNavLink key={item.to} to={item.to} icon={item.icon}>
              {item.label}
            </CollapsedNavLink>
          ))}
        </nav>
      </div>

      <div className="flex flex-col items-center">
        <DropdownMenu>
          <IconTip label={user.name}>
            <DropdownMenuTrigger
              aria-label={`Account — ${user.name}`}
              className="focus-ring-inset flex h-12 w-12 items-center justify-center border-t border-rule transition-colors hover:bg-bone-deep"
            >
              <span className="flex size-[1.375rem] shrink-0 items-center justify-center bg-foreground mono text-[0.5625rem] leading-3 font-medium text-background">
                {initials(user.name)}
              </span>
            </DropdownMenuTrigger>
          </IconTip>
          <AccountMenu
            email={user.email}
            onKeyboard={onKeyboard}
            onSignOut={onSignOut}
          />
        </DropdownMenu>
      </div>
    </div>
  )
}

function GroupRule() {
  return <span aria-hidden className="my-0 block h-px w-6 bg-rule" />
}

/** Name on hover, to the right, in ink — for the marks-only chassis. */
function IconTip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function CollapsedNavLink({
  to,
  params,
  icon: Icon,
  children,
}: {
  to: string
  params?: Record<string, string>
  icon: LucideIcon
  children: string
}) {
  return (
    <IconTip label={children}>
      <Link
        to={to}
        params={params}
        aria-label={children}
        className="group focus-ring-inset flex h-9 w-12 items-center justify-center"
        activeProps={{ 'aria-current': 'page' }}
      >
        {/* Current page = a paper box on a rule (No-Bar Rule), 36×32. */}
        <span className="flex h-8 w-9 items-center justify-center rounded-md border border-transparent transition-colors group-hover:bg-bone-deep group-aria-[current=page]:border-rule group-aria-[current=page]:bg-paper group-aria-[current=page]:group-hover:bg-paper">
          <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
        </span>
      </Link>
    </IconTip>
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
  hint,
  onClick,
  children,
}: {
  to: string
  params?: Record<string, string>
  icon: LucideIcon
  /** The chord printed in the right lane — graphite, ink on the current page. */
  hint?: string
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
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <span className="shrink-0 mono text-micro text-graphite [a[aria-current=page]_&]:text-foreground">
          {hint}
        </span>
      ) : null}
    </Link>
  )
}

// Mark is re-exported for the mobile top bar, which shows it alone.
export { Mark }
