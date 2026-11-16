import { useInfiniteQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent, MouseEvent } from 'react'
import { toast } from 'sonner'
import { formatTime } from '@spaces/core/format'
import { useClock } from '#/components/clock'
import { Band } from '#/components/ledger-section'
import { ListFoot } from '#/components/table/list-foot'
import type { ListFootPage } from '#/components/table/list-foot'
import { ListLoadingRow } from '#/components/table/list-states'
import { Button } from '#/components/ui/button'
import { FolderBody } from '#/components/ui/tabs'
import { listHeadlines } from '#/lib/server-fns'
import type { FeedSource, Headline, HeadlinePage } from '#/lib/server-fns'
import { isTyping, useHotkeys } from '#/lib/use-hotkey'
import { cn } from '#/lib/utils'
import { FeedLogo } from './feed-logo'
import {
  HEADLINES_STEP,
  byDay,
  hasFeedUnder,
  noFeedLine,
  paragraphsOf,
  selectedOf,
  spacesLine,
} from './feed-words'
import { HeadlineReader } from './headline-reader'

/**
 * The Headlines tab: stories on the left under day bands, the selected one
 * read on the right, split by an ink line inside the folder. Each side
 * scrolls on its own and the page does not; the list's foot counts
 * what is loaded of the filter's total and loads the next page.
 * - The newest story is selected on arrival; a click, J and K move the
 *   selection (and keep it in view), O or Enter opens the article in a new
 *   tab. Bare keys are off while typing or in a window.
 * - Narrowing to a space keeps the selection while that story is still in
 *   the list, else the newest is selected.
 * - Below `md` there is no reader: the list fills the page with smaller
 *   photos and a tap opens the article.
 * - A photo still on its way polls the list until it lands.
 */

/** The row's `md` breakpoint, where the reader appears. */
const WIDE = '(min-width: 48rem)'

/** How often the list reads again while a photo is still on its way. */
const PHOTO_POLL_MS = 5_000

const pageOne: string | null = null

const openArticle = (url: string) =>
  void window.open(url, '_blank', 'noopener,noreferrer')

/** One row in the folder in place of the list, on the rule. */
const STATE_ROW =
  'flex h-ledger-row shrink-0 items-center gap-2.5 border-b border-rule px-3 text-ui'

export function HeadlinesPane({
  spaceId,
  initial,
  sources,
  pathOf,
  parentOf,
  onAllSpaces,
}: {
  /** The space the list is narrowed to; null is every space. */
  spaceId: string | null
  /** Page one as the loader read it for this space; null to fetch it here. */
  initial: HeadlinePage | null
  sources: ReadonlyArray<FeedSource>
  pathOf: ReadonlyMap<string, string>
  parentOf: ReadonlyMap<string, string | null>
  onAllSpaces: () => void
}) {
  const query = useInfiniteQuery({
    queryKey: ['feed-headlines', spaceId ?? 'all'],
    // Annotated: inference otherwise narrows `pageParam` to the literal
    // type of `initialPageParam` and refuses the cursor a later page carries.
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      listHeadlines({
        data: {
          limit: HEADLINES_STEP,
          ...(spaceId === null ? {} : { spaceId }),
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      }),
    initialPageParam: pageOne,
    getNextPageParam: (last) => last.nextCursor,
    ...(initial === null
      ? {}
      : { initialData: { pages: [initial], pageParams: [pageOne] } }),
    staleTime: 30_000,
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.headlines.some((h) => h.photoPending))
        ? PHOTO_POLL_MS
        : false,
  })

  // Held here, above the loading state, so narrowing to a space keeps the
  // story while it is still in the list.
  const [chosen, setChosen] = useState<string | null>(null)
  const pages = query.data?.pages
  const headlines = useMemo(
    () => (pages ?? []).flatMap((p) => p.headlines),
    [pages],
  )
  const total = pages?.at(-1)?.total ?? 0

  if (query.isPending)
    return (
      <FolderBody label="Headlines" className="min-h-0 flex-1">
        <ListLoadingRow plural="Headlines" />
      </FolderBody>
    )

  if (query.isError && headlines.length === 0)
    return (
      <FolderBody label="Headlines" className="min-h-0 flex-1">
        <div role="alert" data-list-state="error" className={STATE_ROW}>
          <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
          <span className="min-w-0 flex-1 truncate">
            Couldn&apos;t load headlines. The database did not answer.
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      </FolderBody>
    )

  if (headlines.length === 0) {
    const untagged =
      spaceId !== null && !hasFeedUnder(spaceId, sources, parentOf)
    return (
      <FolderBody label="Headlines" className="min-h-0 flex-1">
        {untagged ? (
          <div data-list-state="no-feed" className={STATE_ROW}>
            <span className="min-w-0 truncate text-graphite">
              {noFeedLine(pathOf.get(spaceId) ?? 'this space')}
            </span>
            <button
              type="button"
              onClick={onAllSpaces}
              className="focus-ring shrink-0 rounded-md font-medium text-primary underline-offset-4 hover:underline"
            >
              All spaces
            </button>
          </div>
        ) : (
          // Feeds that are tagged but have sent nothing yet.
          <p data-list-state="none" className={STATE_ROW}>
            <span className="text-graphite">No headlines yet.</span>
          </p>
        )}
      </FolderBody>
    )
  }

  return (
    <StoriesAndReader
      headlines={headlines}
      chosen={chosen}
      onChoose={setChosen}
      total={total}
      sources={sources}
      pathOf={pathOf}
      page={{
        hasMore: query.hasNextPage,
        loading: query.isFetchingNextPage,
        step: HEADLINES_STEP,
        onLoadMore: () =>
          void query.fetchNextPage().then((r) => {
            if (r.isFetchNextPageError)
              toast.error("Couldn't load more headlines")
          }),
      }}
    />
  )
}

function StoriesAndReader({
  headlines,
  chosen,
  onChoose: setChosen,
  total,
  sources,
  pathOf,
  page,
}: {
  headlines: ReadonlyArray<Headline>
  /** The story picked by a click or a key; null until one is. */
  chosen: string | null
  onChoose: (id: string) => void
  total: number
  sources: ReadonlyArray<FeedSource>
  pathOf: ReadonlyMap<string, string>
  page: ListFootPage
}) {
  const { today } = useClock()
  const selected = selectedOf(headlines, chosen)
  const list = useRef<HTMLDivElement>(null)
  // The story a key moved to, brought into view once it has drawn.
  const reveal = useRef<string | null>(null)
  const latest = useRef(selected)
  latest.current = selected

  const groups = useMemo(() => byDay(headlines, today), [headlines, today])
  const spacesOf = useMemo(
    () => new Map(sources.map((s) => [s.id, spacesLine(s.spaces, pathOf)])),
    [sources, pathOf],
  )

  function move(step: 1 | -1) {
    const at = headlines.findIndex((h) => h.id === latest.current?.id)
    const next = headlines.at(
      Math.min(headlines.length - 1, Math.max(0, at + step)),
    )
    if (next === undefined) return
    reveal.current = next.id
    setChosen(next.id)
  }
  const openSelected = () => {
    const url = latest.current?.url
    if (url != null) openArticle(url)
  }
  useHotkeys([
    ['j', () => move(1)],
    ['k', () => move(-1)],
    ['o', openSelected],
  ])

  // Enter opens the article too, but only from the page or the list: on any
  // other control Enter is that control's.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.shiftKey || isTyping(e)) return
      const t = e.target
      const here =
        t === document.body ||
        (t instanceof Node && list.current?.contains(t) === true)
      const url = latest.current?.url
      if (!here || url == null) return
      e.preventDefault()
      openArticle(url)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const id = reveal.current
    if (id === null) return
    reveal.current = null
    const row = list.current?.querySelector<HTMLElement>(`[data-story="${id}"]`)
    if (row === null || row === undefined) return
    row.scrollIntoView({ block: 'nearest' })
    // Focus follows a key only when it was already in the list.
    if (list.current?.contains(document.activeElement) === true)
      row.focus({ preventScroll: true })
  }, [selected?.id])

  /** Wide, a click selects; narrow, the link opens the article as it is. */
  function onStoryClick(e: MouseEvent, id: string) {
    if (!window.matchMedia(WIDE).matches) return
    e.preventDefault()
    setChosen(id)
  }

  return (
    <FolderBody label="Headlines" className="min-h-0 flex-1 flex-row">
      <div
        data-story-list
        className="flex min-h-0 w-full min-w-0 flex-col md:w-135 md:shrink-0 md:border-r md:border-hairline"
      >
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}>
              <Band label={g.label} />
              <ul>
                {g.headlines.map((h) => (
                  <li key={h.id}>
                    <Story
                      headline={h}
                      selected={h.id === selected?.id}
                      onClick={(e) => onStoryClick(e, h.id)}
                      onFocus={() => setChosen(h.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <ListFoot
          folder
          count={{ shown: headlines.length, total }}
          page={page}
        />
      </div>
      {selected === null ? null : (
        <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
          <HeadlineReader
            key={selected.id}
            headline={selected}
            spaces={spacesOf.get(selected.feedId) ?? ''}
          />
        </div>
      )}
    </FolderBody>
  )
}

/**
 * One story: the source line (logo, name, time), the headline wrapping
 * freely, two lines of summary, and the photo on the right when it has one
 * (no placeholder when it has none). Selected, it is bone with a 2px ink bar
 * on its left edge. A link to the article, so a narrow tap and a middle
 * click open it; a wide click selects instead.
 */
function Story({
  headline: h,
  selected,
  onClick,
  onFocus,
}: {
  headline: Headline
  selected: boolean
  onClick: (e: MouseEvent) => void
  onFocus: (e: FocusEvent) => void
}) {
  const summary = paragraphsOf(h.summary).join(' ')
  const className = cn(
    'focus-ring-inset relative flex w-full gap-4 border-b border-rule px-(--inset) pt-3.5 pb-4 text-left transition-colors duration-150 ease-out-quart hover:bg-row-hover max-md:gap-3',
    selected &&
      'bg-bone before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-hairline',
  )
  const body = (
    <>
      <span className="flex min-w-0 flex-1 basis-0 flex-col gap-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <FeedLogo name={h.feedName} logoUrl={h.logoUrl} />
          <span className="min-w-0 truncate text-label font-medium text-foreground">
            {h.feedName}
          </span>
          <time
            dateTime={h.publishedAt}
            className="shrink-0 mono text-micro text-graphite"
          >
            {formatTime(h.publishedAt)}
          </time>
        </span>
        <span className="headline-serif text-foreground">{h.title}</span>
        {summary === '' ? null : (
          <span className="line-clamp-2 text-ui text-graphite">{summary}</span>
        )}
      </span>
      {h.photoUrl === null ? null : (
        <img
          src={h.photoUrl}
          alt=""
          loading="lazy"
          data-story-photo
          className="mt-5.5 h-18 w-24 shrink-0 border border-hairline bg-paper object-cover max-md:h-14 max-md:w-18"
        />
      )}
    </>
  )
  return h.url === null ? (
    <button
      type="button"
      data-story={h.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      onFocus={onFocus}
      className={className}
    >
      {body}
    </button>
  ) : (
    <a
      href={h.url}
      target="_blank"
      rel="noopener noreferrer"
      data-story={h.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      onFocus={onFocus}
      className={className}
    >
      {body}
    </a>
  )
}
