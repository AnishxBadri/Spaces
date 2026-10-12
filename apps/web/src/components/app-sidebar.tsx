import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  Briefcase,
  Building2,
  CalendarDays,
  CheckSquare,
  Compass,
  FileText,
  Kanban,
  Layers,
  Keyboard,
  MessageSquareText,
  LogOut,
  Paperclip,
  Settings,
  Sunrise,
  Upload,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Mark, Wordmark } from './wordmark'
import { WorkspaceMark } from './workspace-mark'
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
import {
  PINNED_SHOWN,
  PINNED_VIEWS_QUERY,
  STARRED_SHOWN,
  prunePinnedViews,
  setGroupFolded,
  useFoldedGroups,
  usePinnedViews,
  useStarredSpaces,
} from '#/lib/chassis-prefs'
import type { FoldableGroup } from '#/lib/chassis-prefs'
import { objectIcon } from '#/lib/object-icons'
import { listPinnedViews } from '#/lib/server-fns'
import { openUploadDialog } from '#/lib/upload-dialog-store'
import { cn } from '#/lib/utils'

/**
 * The chassis: 232px of bone with a hairline right edge (DESIGN.md §5,
 * sidebar A). Work (Today, Tasks, Spaces with its starred spaces), then three
 * groups that fold per browser — Library, Objects, Capital.
 *
 * - The current row is a hairline box on paper, inside the chassis, expanded
 *   and collapsed. Never a tab cut through the edge, never a pine bar (the
 *   No-Bar Rule).
 * - Every row has the same box, current or not, so nothing shifts.
 * - Pinned saved views stand under their object, indented, three then
 *   `▸ n more`; a pin the server no longer answers is pruned.
 * - Overflow expands inline as `▸ n more`, never a dropdown.
 * - Upload and Settings are icon buttons on the account row; Upload is not a
 *   page, so it is not a row of `NAV_ITEMS`.
 * - Collapsed it is 48px of marks only, with no group headings.
 */

/**
 * The chassis frame's layer: its own stacking context on the z-scale's
 * sticky step, so nothing from `main` paints over it — the note editor's
 * floating handles included. A sheet or menu (z-modal and up) still does.
 */
export const CHASSIS_LAYER = 'isolate z-sticky'

/** The four groups of the chassis, in the order the nav draws them. */
export const NAV_GROUP_IDS = ['work', 'library', 'objects', 'capital'] as const
export type NavGroupId = (typeof NAV_GROUP_IDS)[number]

type NavItem = {
  readonly to: string
  readonly label: string
  readonly icon: LucideIcon
  /**
   * The G-chord printed in the row's right lane. The shell binds it, the
   * keyboard sheet lists it, and `nav-grammar.test.ts` names both pages if
   * two rows claim one letter.
   */
  readonly key: string
  /** Which group the row joins. The groups are derived from this, not sliced. */
  readonly group: NavGroupId
}

export const NAV_ITEMS = [
  // Today first: login lands there, and it is the one attention page (D79).
  { to: '/today', label: 'Today', icon: Sunrise, key: 'G T', group: 'work' },
  {
    to: '/tasks',
    label: 'Tasks',
    icon: CheckSquare,
    key: 'G K',
    group: 'work',
  },
  { to: '/spaces', label: 'Spaces', icon: Layers, key: 'G S', group: 'work' },
  {
    to: '/notes',
    label: 'Notes',
    icon: FileText,
    key: 'G N',
    group: 'library',
  },
  // Meetings takes E: M is Mandate. (D68 amended)
  {
    to: '/meetings',
    label: 'Meetings',
    icon: CalendarDays,
    key: 'G E',
    group: 'library',
  },
  // Files keeps Documents' L (library): D is Deals. (D68 amended)
  {
    to: '/files',
    label: 'Files',
    icon: Paperclip,
    key: 'G L',
    group: 'library',
  },
  {
    to: '/companies',
    label: 'Companies',
    icon: Building2,
    key: 'G C',
    group: 'objects',
  },
  { to: '/people', label: 'People', icon: Users, key: 'G P', group: 'objects' },
  { to: '/deals', label: 'Deals', icon: Kanban, key: 'G D', group: 'objects' },
  // Portfolio takes F (fund) because People has P.
  {
    to: '/portfolio',
    label: 'Portfolio',
    icon: Briefcase,
    key: 'G F',
    group: 'capital',
  },
  {
    to: '/mandate',
    label: 'Mandate',
    icon: Compass,
    key: 'G M',
    group: 'capital',
  },
] as const satisfies readonly NavItem[]

/**
 * The groups, derived by filter: a row says which group it joins, so a row
 * inserted anywhere reshuffles nothing, and `NAV_ITEMS` order means only the
 * order of the ⌘K "Go to" list and the keyboard sheet's Go column.
 */
export const NAV_GROUPS = {
  work: NAV_ITEMS.filter((item) => item.group === 'work'),
  library: NAV_ITEMS.filter((item) => item.group === 'library'),
  objects: NAV_ITEMS.filter((item) => item.group === 'objects'),
  capital: NAV_ITEMS.filter((item) => item.group === 'capital'),
} satisfies Record<NavGroupId, readonly NavItem[]>

/** Custom objects shown before the inline `▸ n more`. */
export const CUSTOM_OBJECTS_SHOWN = 3

const {
  work: WORK,
  library: LIBRARY,
  objects: OBJECTS,
  capital: CAPITAL,
} = NAV_GROUPS

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

type CustomObject = { slug: string; plural: string; icon: string | null }

type PinnedView = Awaited<ReturnType<typeof listPinnedViews>>[number]

/** The list's `?view=`, read without trusting the location's type. */
const viewSearch = z.object({ view: z.string() })
const viewOf = (search: unknown): string | null => {
  const parsed = viewSearch.safeParse(search)
  return parsed.success ? parsed.data.view : null
}

/**
 * The pinned views this user may still open, in pin order. The pins the
 * server was asked about and left out (deleted, or private to someone else)
 * are dropped from storage once the answer lands.
 */
function usePinnedViewRows(): ReadonlyArray<PinnedView> {
  const pins = usePinnedViews()
  const asked = useMemo(() => pins.slice(0, 100), [pins])
  // The last answer stands while a changed pin set is asked about, so the
  // rows never blink; only an answer to these very pins may prune them.
  const { data, isPlaceholderData } = useQuery({
    queryKey: [PINNED_VIEWS_QUERY, asked],
    queryFn: () => listPinnedViews({ data: { ids: [...asked] } }),
    enabled: asked.length > 0,
    placeholderData: keepPreviousData,
  })
  useEffect(() => {
    if (data && !isPlaceholderData)
      prunePinnedViews(asked, new Set(data.map((v) => v.id)))
  }, [asked, data, isPlaceholderData])
  return useMemo(() => {
    if (!data || asked.length === 0) return []
    const byId = new Map(data.map((v) => [v.id, v]))
    return asked.flatMap((id) => byId.get(id) ?? [])
  }, [asked, data])
}

export function AppSidebar({
  user,
  workspaceName,
  workspaceLogo = null,
  objects = [],
  tasksDue = 0,
  onOpenCommand,
  onNavigate,
  hideWordmark = false,
  collapsed = false,
  onToggleCollapsed,
  onOpenKeyboard,
}: {
  user: { name: string; email: string }
  /** The workspace singleton's name — the deployment's identity. */
  workspaceName?: string | null | undefined
  /** The logo's URL; the monogram stands in without one. */
  workspaceLogo?: string | null
  /** Custom objects (spec §9) — they join the nav right after Deals. */
  objects?: Array<CustomObject>
  /** Open tasks due today or overdue; nonzero, Tasks' lane reads `n due`. */
  tasksDue?: number
  onOpenCommand: () => void
  onNavigate?: (() => void) | undefined
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
  const folded = useFoldedGroups()
  const starred = useStarredSpaces()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [starsOpen, setStarsOpen] = useState(false)
  const [objectsOpen, setObjectsOpen] = useState(false)
  const pinned = usePinnedViewRows()
  const currentView = useRouterState({
    select: (s) => viewOf(s.location.search),
  })
  const [pinsOpen, setPinsOpen] = useState<ReadonlyArray<string>>([])

  async function signOut() {
    await authClient.signOut()
    void navigate({ to: '/login' })
  }

  if (collapsed) {
    return (
      <CollapsedSidebar
        user={user}
        workspaceName={workspaceName}
        workspaceLogo={workspaceLogo}
        objects={objects}
        onOpenCommand={onOpenCommand}
        onExpand={onToggleCollapsed}
        onKeyboard={onOpenKeyboard}
        onSignOut={signOut}
      />
    )
  }

  const stars = overflow(
    starred,
    STARRED_SHOWN,
    starsOpen,
    (s) => pathname === `/spaces/${s.id}`,
  )
  const customs = overflow(
    objects,
    CUSTOM_OBJECTS_SHOWN,
    objectsOpen,
    (o) => pathname === `/o/${o.slug}` || pathname.startsWith(`/o/${o.slug}/`),
  )
  // On a starred space its own row is the tab, so Spaces stops matching it.
  const onStarredSpace = stars.shown.some((s) => pathname === `/spaces/${s.id}`)

  /** One object's pinned rows; on one of them, that row is the tab. */
  function pinsUnder(slug: string, path: string) {
    const open = pinsOpen.includes(slug)
    const views = pinned.filter((v) => v.objectSlug === slug)
    const { shown, hidden } = overflow(
      views,
      PINNED_SHOWN,
      open,
      (v) => pathname === path && currentView === v.id,
    )
    return {
      views,
      shown,
      hidden,
      open,
      onPinnedView: shown.some(
        (v) => pathname === path && currentView === v.id,
      ),
      toggle: () =>
        setPinsOpen((o) =>
          o.includes(slug) ? o.filter((x) => x !== slug) : [...o, slug],
        ),
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-bone">
      {/* The chassis edge: a hairline the rows stop short of. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline"
      />
      {hideWordmark ? (
        <div className="h-2 shrink-0" />
      ) : (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline px-4">
          <Link
            to="/spaces"
            onClick={onNavigate}
            className="focus-ring flex min-w-0 items-center gap-2.5"
            // Accessible name must contain the visible text (WCAG 2.5.3).
            aria-label={workspaceName ? `${workspaceName} home` : 'Spaces home'}
          >
            {workspaceName ? (
              <>
                <WorkspaceMark
                  name={workspaceName}
                  logo={workspaceLogo}
                  size={24}
                />
                <span className="truncate text-ui font-medium text-foreground">
                  {workspaceName}
                </span>
              </>
            ) : (
              <Wordmark />
            )}
          </Link>
          <span className="flex shrink-0 items-center gap-2">
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

      <div className="shrink-0 px-3 pt-3 pb-1">
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
        <div className="pt-1">
          <NavLink
            to="/ask"
            icon={MessageSquareText}
            hint={isMac ? '⌘J' : 'Ctrl J'}
            onClick={onNavigate}
          >
            Ask
          </NavLink>
        </div>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-2 pb-3"
        aria-label="Primary"
      >
        <div className="flex flex-col gap-0.5">
          {WORK.map((item) => (
            <div key={item.to} className="contents">
              <NavLink
                to={item.to}
                icon={item.icon}
                hint={
                  item.to === '/tasks' && tasksDue > 0
                    ? `${tasksDue} due`
                    : item.key
                }
                onClick={onNavigate}
                exact={item.to === '/spaces' && onStarredSpace}
              >
                {item.label}
              </NavLink>
              {item.to === '/spaces' ? (
                <>
                  {stars.shown.map((s) => (
                    <NavLink
                      key={`s:${s.id}`}
                      to="/spaces/$spaceId"
                      params={{ spaceId: s.id }}
                      onClick={onNavigate}
                      indent
                    >
                      {s.name}
                    </NavLink>
                  ))}
                  {(
                    starsOpen
                      ? starred.length > STARRED_SHOWN
                      : stars.hidden > 0
                  ) ? (
                    <MoreRow
                      open={starsOpen}
                      hidden={stars.hidden}
                      noun="starred spaces"
                      onToggle={() => setStarsOpen((v) => !v)}
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          ))}
        </div>

        <FoldGroup
          id="library"
          label="Library"
          count={LIBRARY.length}
          folded={folded.includes('library')}
        >
          {LIBRARY.map((item) => (
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
        </FoldGroup>

        <FoldGroup
          id="objects"
          label="Objects"
          count={OBJECTS.length + objects.length}
          folded={folded.includes('objects')}
        >
          {OBJECTS.map((item) => {
            const pins = pinsUnder(item.to.slice(1), item.to)
            return (
              <div key={item.to} className="contents">
                <NavLink
                  to={item.to}
                  icon={item.icon}
                  hint={item.key}
                  onClick={onNavigate}
                  search={pins.onPinnedView ? { view: undefined } : undefined}
                >
                  {item.label}
                </NavLink>
                <PinnedViewRows
                  to={item.to}
                  pins={pins}
                  onNavigate={onNavigate}
                />
              </div>
            )
          })}
          {customs.shown.map((o) => {
            const pins = pinsUnder(o.slug, `/o/${o.slug}`)
            return (
              <div key={`o:${o.slug}`} className="contents">
                <NavLink
                  to="/o/$objectSlug"
                  params={{ objectSlug: o.slug }}
                  icon={objectIcon(o)}
                  onClick={onNavigate}
                  search={pins.onPinnedView ? { view: undefined } : undefined}
                >
                  {o.plural}
                </NavLink>
                <PinnedViewRows
                  to="/o/$objectSlug"
                  params={{ objectSlug: o.slug }}
                  pins={pins}
                  onNavigate={onNavigate}
                />
              </div>
            )
          })}
          {(
            objectsOpen
              ? objects.length > CUSTOM_OBJECTS_SHOWN
              : customs.hidden > 0
          ) ? (
            <MoreRow
              open={objectsOpen}
              hidden={customs.hidden}
              noun="objects"
              onToggle={() => setObjectsOpen((v) => !v)}
            />
          ) : null}
        </FoldGroup>

        <FoldGroup
          id="capital"
          label="Capital"
          count={CAPITAL.length}
          folded={folded.includes('capital')}
        >
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
        </FoldGroup>
      </nav>

      <div className="flex h-12 shrink-0 items-stretch border-t border-rule">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2.5 pr-1 pl-4 text-left transition-colors',
              'hover:bg-bone-deep',
              'focus-ring-inset',
            )}
          >
            {/* Ink square, never the primary: a mark, not a status. */}
            <span className="flex size-[1.375rem] shrink-0 items-center justify-center bg-foreground mono text-field font-medium text-background">
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
          </DropdownMenuTrigger>
          <AccountMenu
            email={user.email}
            onKeyboard={onOpenKeyboard}
            onSignOut={signOut}
          />
        </DropdownMenu>
        <span className="flex shrink-0 items-center gap-0.5 pr-3 pl-1">
          <IconTip label="Upload" side="top">
            <button
              type="button"
              aria-label="Upload"
              onClick={() => {
                onNavigate?.()
                openUploadDialog()
              }}
              className="focus-ring flex size-7 items-center justify-center rounded-md text-graphite transition-colors hover:bg-bone-deep hover:text-foreground"
            >
              <Upload className="size-3.5" strokeWidth={1.75} />
            </button>
          </IconTip>
          <IconTip label="Settings · G ," side="top">
            <Link
              to="/settings"
              aria-label="Settings"
              onClick={onNavigate}
              className="focus-ring flex size-7 items-center justify-center rounded-md text-graphite transition-colors hover:bg-bone-deep hover:text-foreground aria-[current=page]:bg-paper aria-[current=page]:text-foreground"
              activeProps={{ 'aria-current': 'page' }}
            >
              <Settings className="size-3.5" strokeWidth={1.75} />
            </Link>
          </IconTip>
        </span>
      </div>
    </div>
  )
}

/**
 * An object's pinned views: indented rows linking to the list with that view
 * applied (`?view=`), then `▸ n more` past `PINNED_SHOWN`.
 */
function PinnedViewRows({
  to,
  params,
  pins,
  onNavigate,
}: {
  to: string
  params?: Record<string, string> | undefined
  pins: {
    views: ReadonlyArray<PinnedView>
    shown: ReadonlyArray<PinnedView>
    hidden: number
    open: boolean
    toggle: () => void
  }
  onNavigate?: (() => void) | undefined
}) {
  return (
    <>
      {pins.shown.map((v) => (
        <NavLink
          key={`v:${v.id}`}
          to={to}
          params={params}
          search={{ view: v.id }}
          onClick={onNavigate}
          indent
          exact
        >
          {v.name}
        </NavLink>
      ))}
      {(pins.open ? pins.views.length > PINNED_SHOWN : pins.hidden > 0) ? (
        <MoreRow
          open={pins.open}
          hidden={pins.hidden}
          noun="pinned views"
          onToggle={pins.toggle}
        />
      ) : null}
    </>
  )
}

/**
 * Which rows of an overflowing list stand: the first `limit`, all of them
 * when opened, and the current page wherever it sits so the tab never hides.
 */
export function overflow<T>(
  rows: ReadonlyArray<T>,
  limit: number,
  open: boolean,
  isCurrent: (row: T) => boolean,
): { shown: ReadonlyArray<T>; hidden: number } {
  if (open) return { shown: rows, hidden: 0 }
  const shown = rows.filter((row, i) => i < limit || isCurrent(row))
  return { shown, hidden: rows.length - shown.length }
}

/**
 * The account menu opens to the right of the chassis, never up into the
 * screen corner. Settings is the icon beside it; the menu keeps the rest.
 */
function AccountMenu({
  email,
  onKeyboard,
  onSignOut,
}: {
  email: string
  onKeyboard?: (() => void) | undefined
  onSignOut: () => void
}) {
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
 * The collapsed chassis: a 48px cell with the workspace mark on a hairline, ⌘K on a
 * rule, 36px rows of 14px marks with a 24px rule between groups and no
 * headings, the current page in a 36×32 hairline paper box; the foot is Upload,
 * Settings and the ink initials square.
 */
function CollapsedSidebar({
  user,
  workspaceName,
  workspaceLogo,
  objects,
  onOpenCommand,
  onExpand,
  onKeyboard,
  onSignOut,
}: {
  user: { name: string; email: string }
  workspaceName?: string | null | undefined
  workspaceLogo: string | null
  objects: Array<CustomObject>
  onOpenCommand: () => void
  onExpand?: (() => void) | undefined
  onKeyboard?: (() => void) | undefined
  onSignOut: () => void
}) {
  return (
    <div className="relative flex h-full flex-col bg-bone">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-px bg-hairline"
      />
      <IconTip
        label={`Expand sidebar · ⌘\\${workspaceName ? ` · ${workspaceName}` : ''}`}
      >
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand sidebar"
          className="focus-ring-inset flex h-12 w-12 shrink-0 items-center justify-center border-b border-hairline transition-colors hover:bg-bone-deep"
        >
          {workspaceName ? (
            <WorkspaceMark
              name={workspaceName}
              logo={workspaceLogo}
              size={24}
            />
          ) : (
            <Mark className="text-foreground" />
          )}
        </button>
      </IconTip>
      <IconTip label="Search or jump to…">
        <button
          type="button"
          onClick={onOpenCommand}
          aria-label="Search or jump to"
          className="focus-ring-inset flex h-10 w-12 shrink-0 items-center justify-center border-b border-rule mono text-micro text-graphite transition-colors hover:text-foreground"
        >
          {isMac ? '⌘K' : 'Ctrl K'}
        </button>
      </IconTip>

      <nav
        className="flex min-h-0 w-12 flex-1 flex-col items-center overflow-y-auto pt-1.5"
        aria-label="Primary"
      >
        <CollapsedNavLink to="/ask" icon={MessageSquareText}>
          Ask
        </CollapsedNavLink>
        {WORK.map((item) => (
          <CollapsedNavLink key={item.to} to={item.to} icon={item.icon}>
            {item.label}
          </CollapsedNavLink>
        ))}
        <GroupRule />
        {LIBRARY.map((item) => (
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

      <div className="flex shrink-0 flex-col items-center">
        <IconTip label="Upload">
          <button
            type="button"
            onClick={openUploadDialog}
            aria-label="Upload"
            className="focus-ring-inset flex h-10 w-12 items-center justify-center border-t border-rule text-graphite transition-colors hover:bg-bone-deep hover:text-foreground"
          >
            <Upload className="size-3.5" strokeWidth={1.75} />
          </button>
        </IconTip>
        <IconTip label="Settings · G ,">
          <Link
            to="/settings"
            aria-label="Settings"
            className="focus-ring-inset flex h-10 w-12 items-center justify-center border-t border-rule text-graphite transition-colors hover:bg-bone-deep hover:text-foreground aria-[current=page]:text-foreground"
            activeProps={{ 'aria-current': 'page' }}
          >
            <Settings className="size-3.5" strokeWidth={1.75} />
          </Link>
        </IconTip>
        <DropdownMenu>
          <IconTip label={user.name}>
            <DropdownMenuTrigger
              aria-label={`Account — ${user.name}`}
              className="focus-ring-inset flex h-12 w-12 items-center justify-center border-t border-rule transition-colors hover:bg-bone-deep"
            >
              <span
                /* Optical sizing, not a type step: two initials centred in a
                   22px ink square read wrong at the 10px field step. */
                // eslint-disable-next-line instrument/vocabulary
                className="flex size-[1.375rem] shrink-0 items-center justify-center bg-foreground mono text-[0.5625rem] leading-3 font-medium text-background"
              >
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
  return <span aria-hidden className="my-0 block h-px w-6 shrink-0 bg-rule" />
}

/** Name on hover, in ink — for marks-only controls. */
function IconTip({
  label,
  side = 'right',
  children,
}: {
  label: string
  side?: 'right' | 'top'
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
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
  params?: Record<string, string> | undefined
  icon: LucideIcon
  children: string
}) {
  return (
    <IconTip label={children}>
      <Link
        to={to}
        {...(params ? { params } : {})}
        aria-label={children}
        className="group focus-ring-inset flex h-9 w-12 shrink-0 items-center justify-center"
        activeProps={{ 'aria-current': 'page' }}
      >
        {/* Current page = a paper box on a hairline (No-Bar Rule), 36×32. */}
        <span className="flex h-8 w-9 items-center justify-center rounded-md border border-transparent transition-colors group-hover:bg-bone-deep group-aria-[current=page]:border-hairline group-aria-[current=page]:bg-paper group-aria-[current=page]:group-hover:bg-paper">
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

/**
 * A group that folds: the heading is the toggle, `▾` open, `▸ n` folded with
 * its row count. The state is per browser (`chassis-prefs`).
 */
function FoldGroup({
  id,
  label,
  count,
  folded,
  children,
}: {
  id: FoldableGroup
  label: string
  count: number
  folded: boolean
  children: React.ReactNode
}) {
  const listId = useId()
  return (
    <div className="flex flex-col gap-0.5 pt-5">
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={listId}
        onClick={() => setGroupFolded(id, !folded)}
        className="focus-ring flex h-6 items-center gap-1.5 rounded-md px-2.5 text-left text-graphite transition-colors hover:text-foreground"
      >
        <span className="label-caps">{label}</span>
        <span aria-hidden className="mono text-micro">
          {folded ? `▸ ${count}` : '▾'}
        </span>
        {folded ? <span className="sr-only">{`${count} pages`}</span> : null}
      </button>
      <div id={listId} hidden={folded} className="flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  )
}

/** The inline overflow toggle: `▸ n more` expands in place, `▾ less` folds. */
function MoreRow({
  open,
  hidden,
  noun,
  onToggle,
}: {
  open: boolean
  hidden: number
  noun: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? `Show fewer ${noun}` : `Show ${hidden} more ${noun}`}
      onClick={onToggle}
      className="focus-ring flex h-[1.875rem] items-center rounded-md pl-8.5 text-left mono text-micro text-graphite transition-colors hover:text-foreground"
    >
      {open ? '▾ less' : `▸ ${hidden} more`}
    </button>
  )
}

/**
 * One row. Every row carries the same box, a full transparent border inside
 * the nav's gutter, so the current row changes colour only: paper in a
 * hairline box.
 */
function NavLink({
  to,
  params,
  search,
  icon: Icon,
  hint,
  onClick,
  indent = false,
  exact = false,
  children,
}: {
  to: string
  params?: Record<string, string> | undefined
  /**
   * Search the row is current on: a pinned view's `{ view: id }`, or
   * `{ view: undefined }` for its object row while one of its views is the
   * tab — an explicit undefined must be absent from the URL.
   */
  search?: Record<string, string | undefined> | undefined
  icon?: LucideIcon | undefined
  /** The chord printed in the right lane — graphite, ink on the current page. */
  hint?: string | undefined
  onClick?: (() => void) | undefined
  /** A starred space under Spaces: no mark, its label on the labels' lane. */
  indent?: boolean
  /** Match the path exactly, so a child row can be the current one alone. */
  exact?: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      {...(params ? { params } : {})}
      {...(search ? { search } : {})}
      {...(onClick ? { onClick } : {})}
      activeOptions={{
        exact,
        includeSearch: search !== undefined,
        explicitUndefined: true,
      }}
      className={cn(
        'flex h-[1.875rem] shrink-0 items-center gap-2.5 rounded-md border border-transparent pr-2.5 text-ui text-foreground transition-colors',
        indent ? 'pl-8.5' : 'pl-2.5',
        'hover:bg-bone-deep',
        'focus-ring-inset',
      )}
      activeProps={{
        className: 'border-hairline bg-paper font-medium hover:bg-paper',
        'aria-current': 'page',
      }}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" strokeWidth={1.75} /> : null}
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
