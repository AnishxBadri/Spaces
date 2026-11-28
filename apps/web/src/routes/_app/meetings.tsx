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
import { MeetingDialog } from '#/components/meeting-dialog'
import { MeetingSheet } from '#/components/meetings/meeting-sheet'
import { MeetingsLedger } from '#/components/meetings/meetings-ledger'
import type { LedgerState } from '#/components/meetings/meetings-ledger'
import { MeetingsTabBar } from '#/components/meetings/meetings-tab-bar'
import { ListPage, PageBody, PageHeader } from '#/components/page-header'
import { useNow } from '#/components/today/day-strip'
import { Button } from '#/components/ui/button'
import { FolderBody } from '#/components/ui/tabs'
import { defaultOpen, upcomingHorizon } from '#/lib/meetings/list'
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

function MeetingsPage() {
  const search = Route.useSearch()
  const go = Route.useNavigate()
  const queries = useQueryClient()
  const tab: MeetingsTab = search.tab ?? 'upcoming'
  const { stored, ready } = useStoredWhose()
  const whose: Whose = search.whose ?? stored ?? 'mine'
  // A file's window over the page takes the `id`; Back gives it back.
  const open = search.modal === 'file' ? null : (search.id ?? null)
  const split = useSplit()
  const { now: loadedAt, today } = useClock()
  const ticking = useNow()
  const now = useMemo(() => ticking ?? new Date(loadedAt), [ticking, loadedAt])

  const query = useInfiniteQuery({
    queryKey: [MEETINGS_QUERY, tab, whose],
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
  const rows = useMemo(() => (pages ?? []).flatMap((p) => p.rows), [pages])
  const first = pages?.at(0)
  const last = pages?.at(-1)

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

  // Once per list, so a pane closed on purpose stays closed and a meeting
  // opened below the split is never one the reader did not pick.
  const listed = `${tab}\n${whose}`
  const opened = useRef<string | null>(null)
  const firstOpen = first === undefined ? null : defaultOpen(tab, first.rows)
  useEffect(() => {
    if (split !== true || first === undefined || opened.current === listed)
      return
    opened.current = listed
    if (open === null && firstOpen !== null) select(firstOpen, true)
  }, [split, first, firstOpen, listed, open, select])

  const state: LedgerState =
    first !== undefined && last !== undefined
      ? {
          kind: 'loaded',
          rows,
          counts: last.counts,
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
            search: (prev) => ({ ...prev, whose: w, id: undefined }),
            replace: true,
            resetScroll: false,
          })
        }}
      />
      <PageBody className="min-h-0 pt-0">
        <FolderBody label="Meetings" className="min-h-0 flex-1 flex-row">
          <div data-meeting-list className={LIST_PANE}>
            <MeetingsLedger
              tab={tab}
              state={state}
              everyone={whose === 'everyone'}
              open={open}
              now={now}
              today={today}
              onOpen={(id) => select(id)}
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
                  onClose={() => select(null)}
                  onChanged={reread}
                />
              </div>
            ) : null}
          </div>
        </FolderBody>
      </PageBody>
      <MeetingDialog
        id={split === false ? open : null}
        onOpenChange={(o) => {
          if (!o) select(null)
        }}
        onChanged={reread}
      />
    </ListPage>
  )
}
