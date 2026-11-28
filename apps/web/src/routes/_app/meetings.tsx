import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { toast } from 'sonner'
import { useClock } from '#/components/clock'
import { LogInteractionDialog } from '#/components/log-interaction-dialog'
import { FilterChips } from '#/components/list/filter-chips'
import { MeetingDialog } from '#/components/meeting-dialog'
import { MeetingSheet } from '#/components/meetings/meeting-sheet'
import {
  JumpTo,
  MeetingsFilter,
  MeetingsSearch,
  meetingsAppliedFilters,
} from '#/components/meetings/meetings-filters'
import { MeetingsLedger } from '#/components/meetings/meetings-ledger'
import type { LedgerState } from '#/components/meetings/meetings-ledger'
import { MeetingsTabBar } from '#/components/meetings/meetings-tab-bar'
import { NoteModal } from '#/components/notes/note-window'
import { useOpenNoteWindow } from '#/components/notes/note-window-nav'
import { ListPage, PageBody, PageHeader } from '#/components/page-header'
import { useNow } from '#/components/today/day-strip'
import { Button } from '#/components/ui/button'
import { FolderBody } from '#/components/ui/tabs'
import {
  NO_MEETING_FILTERS,
  filtersFor,
  meetingAddressOf,
  meetingFiltersOf,
  meetingFiltersOn,
} from '#/lib/meetings/filter'
import { browserTimeZone } from '#/lib/time-zone'
import type { MeetingsFilters } from '#/lib/meetings/filter'
import { defaultOpen, nextToday, upcomingHorizon } from '#/lib/meetings/list'
import type { MeetingsTab, Whose } from '#/lib/meetings/list'
import { meetingsSearch } from '#/lib/route-search'
import { listMeetings } from '#/lib/server-fns'

/**
 * Meetings: what is ahead as an agenda, and the past with what still owes a
 * write-up first. From 1100px wide the folder is two panes, the list at
 * 480px on the left and the open meeting on the right; below it the list
 * is the page and a row opens the meeting window. A read over meeting and
 * call interactions; a meeting is an activity, never a record.
 * - The open meeting is the URL's `id`, so a reload shows it and Back
 *   returns to the one before. With none addressed, two panes open
 *   Upcoming's next meeting that is not cancelled, or Past's first row.
 * - `Mine · Everyone` is the URL's `whose`, remembered per browser; `Mine`
 *   until the reader picks. A one-member workspace has no control.
 * - `Log interaction` (`L`) opens the log window on Call with nobody in it.
 * - The search (`q`), the filters and Past's `Jump to` month are the URL's
 *   too, so Back restores them. `Member` names one colleague's meetings and
 *   the control then reads `Everyone`; picking `Mine` lets the member go.
 *   A change keeps the open meeting while the new list holds it, else the
 *   pane opens the default one.
 * - A note's or a file's window over the page takes the address's `id`; the
 *   meeting it was opened from stays in the pane behind it, and closing the
 *   window steps back to that meeting.
 */
export const Route = createFileRoute('/_app/meetings')({
  validateSearch: meetingsSearch,
  component: MeetingsPage,
})

/** Where the folder splits into two panes. */
const SPLIT_QUERY = '(min-width: 1100px)'

function subscribeSplit(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(SPLIT_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Whether the folder is two panes; null until the browser answers, so the
 * server render opens neither a pane nor a window.
 */
function useSplit(): boolean | null {
  return useSyncExternalStore(
    subscribeSplit,
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(SPLIT_QUERY).matches,
    () => null,
  )
}

/** The reader's last `Mine · Everyone`, kept in this browser. */
const WHOSE_KEY = 'spaces.meetings.whose'

function readWhose(): Whose | null {
  try {
    const v = window.localStorage.getItem(WHOSE_KEY)
    return v === 'mine' || v === 'everyone' ? v : null
  } catch {
    return null
  }
}

function keepWhose(whose: Whose) {
  try {
    window.localStorage.setItem(WHOSE_KEY, whose)
  } catch {
    // Storage refused (a private window): the URL still holds the choice.
  }
}

/**
 * The remembered choice, read after mount so the server and the first
 * client render agree; `ready` once it has been read.
 */
function useStoredWhose(): { stored: Whose | null; ready: boolean } {
  const [state, setState] = useState<{
    stored: Whose | null
    ready: boolean
  }>({ stored: null, ready: false })
  useEffect(() => {
    setState({ stored: readWhose(), ready: true })
  }, [])
  return state
}

/**
 * The left pane: the whole folder below the split, 480px beside the right
 * one from it, an ink line between them: the list and the open item are two
 * things.
 */
const LIST_PANE =
  'flex min-h-0 w-full min-w-0 flex-col min-[1100px]:w-120 min-[1100px]:shrink-0 min-[1100px]:border-r min-[1100px]:border-hairline'

/** The right pane: bone until a meeting is open, and absent below the split. */
const OPEN_PANE = 'hidden min-h-0 min-w-0 flex-1 bg-bone min-[1100px]:flex'

const MEETINGS_QUERY = 'meetings'

/** Where a page of the list was read from: the instants travel with Past's cursor. */
type PageParam = { now: string; until: string; cursor: string } | null

/** The address's facet keys, cleared when the tab changes: each tab reads its own. */
const TAB_FACETS = {
  kind: undefined,
  wu: undefined,
  cancelled: undefined,
  month: undefined,
} as const

function MeetingsPage() {
  const search = Route.useSearch()
  const go = Route.useNavigate()
  const queries = useQueryClient()
  const tab: MeetingsTab = search.tab ?? 'upcoming'
  const { stored, ready } = useStoredWhose()
  const q = search.q ?? ''
  const { with: withId, member, kind, wu, cancelled } = search
  const allFilters = useMemo(
    () => meetingFiltersOf({ with: withId, member, kind, wu, cancelled }),
    [withId, member, kind, wu, cancelled],
  )
  const filters = useMemo(() => filtersFor(allFilters, tab), [allFilters, tab])
  const month = tab === 'past' ? (search.month ?? null) : null
  // `Member` is one colleague's meetings, so it reads under `Everyone`.
  const whose: Whose =
    filters.member !== null ? 'everyone' : (search.whose ?? stored ?? 'mine')
  const on = meetingFiltersOn(filters, tab)
  const narrowed = on > 0 ? 'filter' : q !== '' ? 'search' : 'none'
  const zone = useMemo(() => browserTimeZone(), [])
  // A note's or a file's window over the page takes the `id`, so the
  // meeting last addressed stays behind it until the window closes.
  const windowed = search.modal === 'file' || search.modal === 'note'
  const addressed = windowed ? null : (search.id ?? null)
  const [behind, setBehind] = useState<string | null>(addressed)
  if (!windowed && addressed !== behind) setBehind(addressed)
  const open = windowed ? behind : addressed
  const openNote = useOpenNoteWindow()
  const split = useSplit()
  const { now: loadedAt, today } = useClock()
  const ticking = useNow()
  const now = useMemo(() => ticking ?? new Date(loadedAt), [ticking, loadedAt])

  const query = useInfiniteQuery({
    queryKey: [MEETINGS_QUERY, tab, whose, q, filters, month],
    enabled: ready,
    // Annotated: inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: async ({ pageParam }: { pageParam: PageParam }) => {
      const at = new Date()
      const from = pageParam ?? {
        now: at.toISOString(),
        until: upcomingHorizon(at).toISOString(),
      }
      const page = await listMeetings({
        data: {
          tab,
          whose,
          now: from.now,
          until: from.until,
          q,
          filters,
          tz: zone,
          ...(month === null ? {} : { month }),
          ...(pageParam === null ? {} : { cursor: pageParam.cursor }),
        },
      })
      return { ...page, now: from.now, until: from.until }
    },
    initialPageParam: null,
    getNextPageParam: (last): PageParam =>
      last.nextCursor === null
        ? null
        : { now: last.now, until: last.until, cursor: last.nextCursor },
  })
  const pages = query.data?.pages
  // Meetings removed from Spaces, kept out of the list while it reads again.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(
    () => (pages ?? []).flatMap((p) => p.rows).filter((m) => !gone.has(m.id)),
    [pages, gone],
  )
  const first = pages?.at(0)
  const later = useMemo(
    () => (first?.later ?? []).filter((m) => !gone.has(m.id)),
    [first, gone],
  )
  const last = pages?.at(-1)
  const named = first?.named ?? { with: null, member: null }

  const reread = useCallback(
    () => void queries.invalidateQueries({ queryKey: [MEETINGS_QUERY] }),
    [queries],
  )

  /** Opens a meeting: a new history entry, unless it stands in for none. */
  const select = useCallback(
    (id: string | null, replace = false) =>
      void go({
        search: (prev) => ({
          ...prev,
          modal: undefined,
          id: id ?? undefined,
        }),
        replace,
        resetScroll: false,
      }),
    [go],
  )

  // A filter is its own history step, so Back undoes it.
  const filterBy = (next: MeetingsFilters) =>
    void go({
      search: (prev) => ({ ...prev, ...meetingAddressOf(next) }),
      resetScroll: false,
    })
  const searchFor = (text: string) =>
    void go({
      search: (prev) => ({ ...prev, q: text === '' ? undefined : text }),
      replace: true,
      resetScroll: false,
    })
  const jump = (to: string | null) =>
    void go({
      search: (prev) => ({ ...prev, month: to ?? undefined }),
      resetScroll: false,
    })

  // Once per list, so a pane closed on purpose stays closed and a meeting
  // opened below the split is never one the reader did not pick. When the
  // search, a filter or the month changed the list, the open meeting stays
  // only while the new list holds it.
  const scope = `${tab}\n${whose}`
  const listed = `${scope}\n${JSON.stringify([q, filters, month])}`
  const opened = useRef<{ listed: string; scope: string } | null>(null)
  const firstOpen =
    first === undefined
      ? null
      : defaultOpen(
          tab,
          first.rows.filter((m) => !gone.has(m.id)),
        )
  const held =
    first === undefined || open === null
      ? false
      : rows.some((m) => m.id === open) || later.some((m) => m.id === open)
  useEffect(() => {
    // A window over the page keeps the pane as it is until it closes.
    if (
      split !== true ||
      first === undefined ||
      windowed ||
      opened.current?.listed === listed
    )
      return
    const narrowedHere = opened.current?.scope === scope
    opened.current = { listed, scope }
    if (open === null) {
      if (firstOpen !== null) select(firstOpen, true)
    } else if (narrowedHere && !held) select(firstOpen, true)
  }, [split, first, firstOpen, listed, scope, open, held, select, windowed])

  // A removed meeting leaves the pane to what the list opens by default.
  const removed = useCallback(
    (id: string) => {
      setGone((prev) => new Set(prev).add(id))
      opened.current = null
      select(null, true)
      reread()
    },
    [select, reread],
  )

  const state: LedgerState =
    first !== undefined && last !== undefined
      ? {
          kind: 'loaded',
          rows,
          later,
          counts: last.counts,
          shown: first.shown,
          bands: first.bands,
          narrowed,
          jumped: month !== null,
          calendar: first.calendar,
          audience: first.audience,
          ...(tab === 'past'
            ? {
                page: {
                  hasMore: query.hasNextPage,
                  loading: query.isFetchingNextPage,
                  onLoadMore: () =>
                    void query.fetchNextPage().then((r) => {
                      if (r.isFetchNextPageError)
                        toast.error('Could not load more meetings')
                    }),
                },
              }
            : {}),
        }
      : query.isError
        ? { kind: 'failed', onRetry: () => void query.refetch() }
        : { kind: 'loading' }

  const read = { tab, whose, q, filters, tz: zone }
  return (
    <ListPage>
      <PageHeader
        title="Meetings"
        index
        action={
          <LogInteractionDialog
            hotkey="l"
            defaultKind="call"
            onLogged={reread}
            trigger={<Button shortcut="L">Log interaction</Button>}
          />
        }
      />
      <MeetingsTabBar
        tab={tab}
        counts={last?.counts ?? null}
        onTabChange={(t) =>
          void go({
            search: (prev) => ({
              ...prev,
              ...TAB_FACETS,
              tab: t === 'upcoming' ? undefined : t,
              modal: undefined,
              id: undefined,
            }),
            resetScroll: false,
          })
        }
        whose={first === undefined || !first.team ? null : whose}
        onWhoseChange={(w) => {
          keepWhose(w)
          void go({
            search: (prev) => ({
              ...prev,
              whose: w,
              // `Mine` is the reader's own: a chosen colleague lets go.
              ...(w === 'mine' ? { member: undefined } : {}),
              id: undefined,
            }),
            replace: true,
            resetScroll: false,
          })
        }}
        trail={
          <>
            <MeetingsFilter read={read} named={named} onChange={filterBy} />
            {tab === 'past' ? (
              <JumpTo read={read} month={month} onJump={jump} />
            ) : null}
            <MeetingsSearch q={q} onSearch={searchFor} />
          </>
        }
      />
      <PageBody className="min-h-0 pt-0">
        <FolderBody label="Meetings" className="min-h-0 flex-1 flex-row">
          <div data-meeting-list className={LIST_PANE}>
            <MeetingsLedger
              // A jump opens the list at the top of the month it read.
              key={month ?? ''}
              tab={tab}
              state={state}
              everyone={whose === 'everyone'}
              open={open}
              now={now}
              today={today}
              onOpen={(id) => select(id)}
              head={
                <FilterChips
                  filters={meetingsAppliedFilters(
                    filters,
                    tab,
                    named,
                    filterBy,
                  )}
                  onClear={() => filterBy(NO_MEETING_FILTERS)}
                />
              }
            />
          </div>
          <div data-open-pane className={OPEN_PANE}>
            {split === true && open !== null ? (
              <div
                data-meeting-pane
                className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper"
              >
                <MeetingSheet
                  key={open}
                  id={open}
                  frame="pane"
                  next={tab === 'upcoming' && nextToday(rows, now) === open}
                  onClose={() => select(null)}
                  onChanged={reread}
                  onRemoved={() => removed(open)}
                  onOpenNote={openNote}
                />
              </div>
            ) : null}
          </div>
        </FolderBody>
      </PageBody>
      <MeetingDialog
        // The note window stands in its place; closing it brings it back.
        id={split === false && !windowed ? open : null}
        onOpenChange={(o) => {
          if (!o) select(null)
        }}
        onChanged={reread}
        onOpenNote={openNote}
      />
      <NoteModal />
    </ListPage>
  )
}
