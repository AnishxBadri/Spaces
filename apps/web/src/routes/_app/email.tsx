import { createFileRoute } from '@tanstack/react-router'
import { icon } from '#/components/icons'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { toast } from 'sonner'
import { useClock } from '#/components/clock'
import { EmailDialog, EmailPane } from '#/components/email-dialog'
import { DraftComposer } from '#/components/email/draft-composer'
import { PaneHead } from '#/components/email/pane-head'
import { Band } from '#/components/ledger-section'
import { ComposeModal, NewEmailSplit } from '#/components/email/compose-windows'
import {
  FolderGround,
  ListPage,
  PageBody,
  PageHeader,
} from '#/components/page-header'
import { ThreadRow } from '#/components/record/thread-row'
import { ListFoot } from '#/components/table/list-foot'
import { ListErrorRow, ListLoadingRow } from '#/components/table/list-states'
import { Twinkle } from '#/components/twinkle'
import { Input } from '#/components/ui/input'
import { Segmented } from '#/components/ui/segmented'
import { FolderBody, Tabs } from '#/components/ui/tabs'
import {
  EMAIL_DRAFTS_QUERY,
  draftStateOf,
  openCompose,
  useComposeHere,
} from '#/lib/email/compose'
import {
  THREADS_STEP,
  THREAD_FILTERS,
  THREAD_FILTER_LABEL,
  draftLine,
  threadDay,
} from '#/lib/email/threads'
import type { EmailTab, ThreadFilter } from '#/lib/email/threads'
import { emailSearch } from '#/lib/route-search'
import {
  getEmailDraft,
  listEmailDrafts,
  listEmailThreads,
} from '#/lib/server-fns'
import type { DraftRow, EmailThreadRow } from '#/lib/server-fns'
import { byWeek } from '#/lib/timeline/weeks'
import { cn } from '#/lib/utils'

/**
 * Email: every thread the workspace holds and the reader's own drafts, in
 * two folder tabs. From about 1100px wide the folder is two panes, the list
 * at 480px on the left and the open thread or draft on the right; below it
 * the list is the page and a thread opens in the email window. Not an
 * inbox: nothing is unread, archived or sent apart.
 * - The open item is the URL's `id`: the thread's newest message, or the
 *   draft. Nothing open leaves the pane empty bone.
 * - Both lists hang under the drafts key, so a save, a send or a trash
 *   anywhere re-reads the Draft marks, the tab's count and the list.
 * - The head's `New email ⌄` opens the composer as a window over the page,
 *   from the URL (`modal=email&new=1&draft=`), templates in its menu.
 */
export const Route = createFileRoute('/_app/email')({
  validateSearch: emailSearch,
  component: EmailPage,
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

/** The left pane: the whole folder below the split, 480px beside the right one from it. */
const LIST_PANE =
  'flex min-h-0 w-full min-w-0 flex-col min-[1100px]:w-120 min-[1100px]:shrink-0 min-[1100px]:border-r min-[1100px]:border-rule'

/** The right pane: bone until something is open, and absent below the split. */
const OPEN_PANE = 'hidden min-h-0 min-w-0 flex-1 bg-bone min-[1100px]:flex'

/** One row standing in for the list: loading, failed, or nothing there. */
const STATE_ROW =
  'flex h-ledger-row shrink-0 items-center gap-2.5 border-b border-rule px-3 text-ui'

const DRAFTS_LIST = [EMAIL_DRAFTS_QUERY, 'list'] as const

/** A row of the Drafts list; `notSent` leads a draft whose send failed. */
type DraftItem = DraftRow & { readonly notSent?: boolean | undefined }

function EmailPage() {
  const search = Route.useSearch()
  const go = Route.useNavigate()
  const tab: EmailTab = search.tab ?? 'threads'
  const filter: ThreadFilter = search.filter ?? 'all'
  const open = search.id ?? null
  const split = useSplit()
  const composeHere = useComposeHere()

  const drafts = useQuery({
    queryKey: DRAFTS_LIST,
    queryFn: (): Promise<Array<DraftItem>> => listEmailDrafts(),
  })

  const select = (id: string | null) =>
    void go({
      search: (prev) => ({ ...prev, id: id ?? undefined }),
      replace: true,
      resetScroll: false,
    })

  return (
    <ListPage>
      <PageHeader
        title="Email"
        folds={false}
        action={<NewEmailSplit variant="primary" onNew={composeHere} />}
      />
      <FolderGround>
        <Tabs
          label="Email"
          value={tab}
          onValueChange={(t) =>
            void go({
              search: (prev) => ({
                ...prev,
                tab: t === 'threads' ? undefined : t,
                id: undefined,
              }),
              resetScroll: false,
            })
          }
          items={[
            { id: 'threads', label: 'Threads', uncounted: true },
            {
              id: 'drafts',
              label: 'Drafts',
              ...(drafts.data === undefined
                ? {}
                : { count: drafts.data.length }),
            },
          ]}
        />
      </FolderGround>
      <PageBody className="min-h-0 pt-0">
        {tab === 'threads' ? (
          <ThreadsFolder
            filter={filter}
            q={search.q ?? ''}
            open={open}
            split={split}
            onSelect={select}
            onFilter={(f) =>
              void go({
                search: (prev) => ({
                  ...prev,
                  filter: f === 'all' ? undefined : f,
                }),
                replace: true,
                resetScroll: false,
              })
            }
            onSearch={(q) =>
              void go({
                search: (prev) => ({ ...prev, q: q === '' ? undefined : q }),
                replace: true,
                resetScroll: false,
              })
            }
          />
        ) : (
          <DraftsFolder
            rows={drafts.data}
            failed={drafts.isError}
            onRetry={() => void drafts.refetch()}
            open={open}
            split={split}
            onSelect={(id) => {
              // Below the split the composer opens as its own window.
              if (split === false) openCompose({ draftId: id })
              else select(id)
            }}
            onClose={() => select(null)}
          />
        )}
      </PageBody>
      <EmailDialog
        id={split === false && tab === 'threads' ? open : null}
        onOpenChange={(o) => {
          if (!o) select(null)
        }}
      />
      <ComposeModal recordId={null} />
    </ListPage>
  )
}

function ThreadsFolder({
  filter,
  q,
  open,
  split,
  onSelect,
  onFilter,
  onSearch,
}: {
  filter: ThreadFilter
  q: string
  open: string | null
  split: boolean | null
  onSelect: (id: string | null) => void
  onFilter: (f: ThreadFilter) => void
  onSearch: (q: string) => void
}) {
  const { now, today } = useClock()
  const query = useInfiniteQuery({
    queryKey: [EMAIL_DRAFTS_QUERY, 'threads', filter, q],
    // Annotated: inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listEmailThreads({
        data: {
          filter,
          limit: THREADS_STEP,
          ...(q === '' ? {} : { q }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      }),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const pages = query.data?.pages
  const threads = useMemo(
    () => (pages ?? []).flatMap((p) => p.threads),
    [pages],
  )
  const total = pages?.at(-1)?.total ?? 0
  const groups = useMemo(() => byWeek(threads, today), [threads, today])

  return (
    <FolderBody label="Threads" className="min-h-0 flex-1 flex-row">
      <div data-thread-list className={LIST_PANE}>
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-rule px-3">
          <Segmented
            label="Whose threads"
            value={filter}
            options={THREAD_FILTERS.map((f) => ({
              id: f,
              label: THREAD_FILTER_LABEL[f],
            }))}
            onChange={onFilter}
            className="shrink-0"
          />
          <ThreadSearch q={q} onSearch={onSearch} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isPending ? (
            <ListLoadingRow plural="Threads" />
          ) : query.isError && threads.length === 0 ? (
            <ListErrorRow
              plural="Threads"
              onRetry={() => void query.refetch()}
            />
          ) : threads.length === 0 ? (
            <p data-list-state="none" className={STATE_ROW}>
              <span className="text-graphite">
                {filter === 'all' && q === ''
                  ? 'No email yet.'
                  : 'Nothing matches that filter.'}
              </span>
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.band} aria-label={g.band}>
                <Band label={g.band} className="bg-paper" />
                <ol>
                  {g.rows.map((t) => (
                    <ThreadRow
                      key={t.id}
                      item={itemOf(t)}
                      messages={t.messages}
                      pane={{
                        records: t.records.map((r) => r.name),
                        draft: t.draft,
                        day: threadDay(t.at, now),
                        selected: t.id === open,
                        onSelect: () => onSelect(t.id),
                      }}
                    />
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
        <ListFoot
          {...(threads.length === 0
            ? {}
            : { count: { shown: threads.length, total } })}
          page={{
            hasMore: query.hasNextPage,
            loading: query.isFetchingNextPage,
            step: THREADS_STEP,
            onLoadMore: () =>
              void query.fetchNextPage().then((r) => {
                if (r.isFetchNextPageError)
                  toast.error('Could not load more threads')
              }),
          }}
        />
      </div>
      <div data-open-pane className={OPEN_PANE}>
        {split === true && open !== null ? (
          <EmailPane id={open} onClose={() => onSelect(null)} />
        ) : null}
      </div>
    </FolderBody>
  )
}

/** A thread as the shared row reads it. */
function itemOf(t: EmailThreadRow) {
  return {
    id: t.id,
    kind: 'email',
    subject: t.subject,
    noteId: null,
    privateBody: t.privateBody,
    at: t.at,
    attendees: t.attendees,
    sent: t.sent,
    attachments: t.attachments,
    attachmentNames: t.attachmentNames,
    summary: t.summary,
  }
}

/** How long the search waits after the last key before it asks again. */
const SEARCH_QUIET_MS = 250

/**
 * The search icon, which opens a field in its place. The field asks once
 * typing pauses; Escape empties and closes it.
 */
function ThreadSearch({
  q,
  onSearch,
}: {
  q: string
  onSearch: (q: string) => void
}) {
  const [opened, setOpened] = useState(q !== '')
  const [text, setText] = useState(q)
  const latest = useRef(onSearch)
  latest.current = onSearch

  useEffect(() => {
    if (text.trim() === q) return
    const timer = setTimeout(() => latest.current(text.trim()), SEARCH_QUIET_MS)
    return () => clearTimeout(timer)
  }, [text, q])

  if (!opened)
    return (
      <button
        type="button"
        aria-label="Search threads"
        onClick={() => setOpened(true)}
        className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md border border-rule text-graphite transition-colors hover:text-foreground"
      >
        <icon.search aria-hidden className="size-4" />
      </button>
    )
  return (
    <Input
      autoFocus
      type="search"
      aria-label="Search threads"
      placeholder="Search threads…"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        setText('')
        latest.current('')
        setOpened(false)
      }}
      className="h-7 max-w-60 min-w-0 flex-1"
    />
  )
}

function DraftsFolder({
  rows,
  failed,
  onRetry,
  open,
  split,
  onSelect,
  onClose,
}: {
  rows: ReadonlyArray<DraftItem> | undefined
  failed: boolean
  onRetry: () => void
  open: string | null
  split: boolean | null
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const { now } = useClock()
  return (
    <FolderBody label="Drafts" className="min-h-0 flex-1 flex-row">
      <div data-draft-list className={LIST_PANE}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows === undefined ? (
            failed ? (
              <ListErrorRow plural="Drafts" onRetry={onRetry} />
            ) : (
              <ListLoadingRow plural="Drafts" />
            )
          ) : rows.length === 0 ? (
            <p data-list-state="none" className={STATE_ROW}>
              <span className="text-graphite">No drafts.</span>
            </p>
          ) : (
            <ol>
              {rows.map((r) => (
                <DraftListRow
                  key={r.id}
                  row={r}
                  day={threadDay(r.updatedAt, now)}
                  selected={r.id === open}
                  onSelect={() => onSelect(r.id)}
                />
              ))}
            </ol>
          )}
        </div>
      </div>
      <div data-open-pane className={OPEN_PANE}>
        {split === true && open !== null ? (
          <DraftPane key={open} id={open} onClose={onClose} />
        ) : null}
      </div>
    </FolderBody>
  )
}

/**
 * One draft: the subject with when it was saved, then the mode and who it
 * goes to. One whose send failed leads with a crimson square and `Not sent`.
 */
function DraftListRow({
  row,
  day,
  selected,
  onSelect,
}: {
  row: DraftItem
  day: string
  selected: boolean
  onSelect: () => void
}) {
  const notSent = row.notSent === true
  return (
    <li
      data-draft={row.id}
      {...(selected ? { 'data-selected': '' } : {})}
      className="border-b border-rule"
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'focus-ring-inset relative flex w-full flex-col gap-0.5 px-(--inset) py-2.25 text-left transition-colors duration-150 ease-out-quart hover:bg-row-hover',
          selected &&
            'bg-bone before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-hairline',
        )}
      >
        <span className="flex h-5 min-w-0 items-center gap-3">
          <span className="flex w-4 shrink-0 justify-center">
            {notSent ? (
              <span aria-hidden className="size-2 bg-destructive" />
            ) : null}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ui',
              row.subject === '' ? 'text-graphite' : 'text-foreground',
            )}
          >
            {row.subject === '' ? '(no subject)' : row.subject}
          </span>
          <span
            className={cn(
              'shrink-0 mono text-micro whitespace-nowrap',
              notSent ? 'text-destructive' : 'text-graphite',
            )}
          >
            {notSent ? 'Not sent' : `Saved ${day}`}
          </span>
        </span>
        <span className="min-w-0 truncate pl-7 text-label text-graphite">
          {draftLine(row)}
        </span>
      </button>
    </li>
  )
}

/** The composer for one draft, in the pane, under its subject. */
function DraftPane({ id, onClose }: { id: string; onClose: () => void }) {
  const draft = useQuery({
    queryKey: ['email-draft', id],
    queryFn: () => getEmailDraft({ data: { id } }),
    // The composer owns the draft once it is open; a refetch would not reach it.
    staleTime: Infinity,
    gcTime: 0,
  })
  if (draft.data === undefined)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PaneHead title="Draft" />
        <div className="flex flex-1 items-center justify-center px-4">
          {draft.isError ? (
            <p className="text-ui text-destructive">
              {draft.error instanceof Error
                ? draft.error.message
                : 'Could not open the draft'}
            </p>
          ) : (
            <Twinkle size={29} />
          )}
        </div>
      </div>
    )
  return (
    <div
      data-draft-pane
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-paper"
    >
      <PaneHead title={draft.data.subject || 'New email'} />
      {/* The composer's body and foot run to the pane's edges from this inset. */}
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <DraftComposer
          initial={draftStateOf(draft.data)}
          savedAt={draft.data.updatedAt}
          onClose={onClose}
        />
      </div>
    </div>
  )
}
