import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { DitherNoun } from '#/components/dither-noun'
import { Band, FoldRow } from '#/components/ledger-section'
import { FoldBand } from '#/components/list/fold-band'
import { DateLeaf } from '#/components/meetings/date-leaf'
import { AgendaRow, LaterRow, PastRow } from '#/components/meetings/meeting-row'
import { meetingsWord } from '#/components/meetings/meetings-filters'
import { NeedsSetup } from '#/components/needs-setup'
import { ListFoot } from '#/components/table/list-foot'
import type { ListFootPage } from '#/components/table/list-foot'
import { ListErrorRow, ListLoadingRow } from '#/components/table/list-states'
import {
  byDay,
  LATER_SHOWN,
  laterEnd,
  laterMonths,
  nextToday,
  pastBands,
  PAST_STEP,
} from '#/lib/meetings/list'
import type {
  ListedMeeting,
  MeetingCounts,
  MeetingsTab,
} from '#/lib/meetings/list'
import type { SetupAudience } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/** One row standing in for the list: nothing there, or what is missing. */
const STATE_ROW =
  'flex h-ledger-row shrink-0 items-center gap-2.5 border-b border-rule px-3 text-ui'

/** What the list pane is drawing. */
export type LedgerState =
  | { kind: 'loading' }
  | { kind: 'failed'; onRetry: () => void }
  | {
      kind: 'loaded'
      rows: ReadonlyArray<ListedMeeting>
      /** Upcoming's meetings after the two weeks; empty on Past. */
      later: ReadonlyArray<ListedMeeting>
      counts: MeetingCounts
      /** What the search and filters leave of the open tab. */
      shown: number
      /** Past's rows per band while narrowed, by band key; else null. */
      bands: Readonly<Record<string, number>> | null
      /** What narrows the list: nothing, the search, or a filter. */
      narrowed: 'none' | 'search' | 'filter'
      /** Past is read from a month down (`Jump to`), newest first alone. */
      jumped: boolean
      calendar: boolean
      audience: SetupAudience
      /** Past's next page; absent on Upcoming. */
      page?: Omit<ListFootPage, 'step'> | undefined
    }

/**
 * The Meetings list pane's body and foot: Upcoming as an agenda, each day's
 * leaf in a bone margin beside its rows, or Past in bands; the loading,
 * failed and empty states in their place; the foot with the tab's count,
 * or `5 of 241` while the search or a filter narrows it. `head` heads the
 * pane: the applied filters' chips.
 */
export function MeetingsLedger({
  tab,
  state,
  everyone,
  open,
  now,
  today,
  onOpen,
  head,
}: {
  tab: MeetingsTab
  state: LedgerState
  head?: ReactNode
  /** The list holds the team's meetings. */
  everyone: boolean
  open: string | null
  /** The ticking clock. */
  now: Date
  /** The reader's local day, `YYYY-MM-DD`. */
  today: string
  onOpen: (id: string) => void
}) {
  const loaded = state.kind === 'loaded' ? state : null
  const total =
    loaded === null
      ? null
      : tab === 'upcoming'
        ? loaded.counts.upcoming
        : loaded.counts.past
  const narrowed = loaded !== null && loaded.narrowed !== 'none'
  return (
    <>
      {head}
      <div
        data-meeting-scroll
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {state.kind === 'loading' ? (
          <ListLoadingRow plural="Meetings" />
        ) : state.kind === 'failed' ? (
          <ListErrorRow
            plural="Meetings"
            line="The database did not answer."
            onRetry={state.onRetry}
          />
        ) : state.rows.length === 0 && state.later.length === 0 ? (
          state.narrowed === 'none' ? (
            <Empty
              tab={tab}
              calendar={state.calendar}
              audience={state.audience}
            />
          ) : (
            <p data-list-state="no-match" className={STATE_ROW}>
              <span className="text-graphite">
                {state.narrowed === 'filter'
                  ? 'Nothing matches that filter.'
                  : 'Nothing matches.'}
              </span>
            </p>
          )
        ) : tab === 'upcoming' ? (
          <Agenda
            rows={state.rows}
            later={state.later}
            everyone={everyone}
            open={open}
            now={now}
            today={today}
            onOpen={onOpen}
          />
        ) : (
          <PastList
            rows={state.rows}
            unwritten={state.counts.unwritten}
            bands={state.bands}
            jumped={state.jumped}
            open={open}
            today={today}
            onOpen={onOpen}
          />
        )}
      </div>
      <ListFoot
        {...(loaded === null || total === null
          ? {}
          : narrowed
            ? { count: { shown: loaded.shown, total } }
            : total === 0
              ? {}
              : { words: meetingsWord(total) })}
        {...(loaded?.page === undefined
          ? {}
          : { page: { ...loaded.page, step: PAST_STEP } })}
      />
    </>
  )
}

/**
 * Nothing to list. With no calendar connected an admin is offered Google
 * and a member told whom to ask; with one, Upcoming draws the calendar and
 * `Nothing ahead`.
 */
function Empty({
  tab,
  calendar,
  audience,
}: {
  tab: MeetingsTab
  calendar: boolean
  audience: SetupAudience
}) {
  if (!calendar)
    return (
      <div data-list-state="setup" className={STATE_ROW}>
        <NeedsSetup
          needs="No calendar connected"
          action="Connect Google"
          to="/settings/email-calendar"
          thing="Google"
          ask="connect"
          audience={audience}
        />
      </div>
    )
  if (tab === 'past')
    return (
      <p data-list-state="none" className={STATE_ROW}>
        <span className="text-graphite">No past meetings.</span>
      </p>
    )
  return (
    <div
      data-list-state="nothing-ahead"
      className="flex flex-1 flex-col items-center justify-center gap-4 p-6"
    >
      <DitherNoun kind="meetings" />
      <h2 className="font-serif text-head font-semibold text-foreground">
        Nothing ahead
      </h2>
    </div>
  )
}

/** The bone margin that holds a day's leaf, and runs on under the last day. */
const MARGIN = 'w-17 shrink-0 border-r border-rule bg-bone'

/**
 * Upcoming as an agenda: a day's leaf in the margin beside its rows, the
 * margin running on to the foot under the last day; then, when there are
 * meetings after the two weeks, the `Later n` fold that closes the list.
 */
function Agenda({
  rows,
  later,
  everyone,
  open,
  now,
  today,
  onOpen,
}: {
  rows: ReadonlyArray<ListedMeeting>
  later: ReadonlyArray<ListedMeeting>
  everyone: boolean
  open: string | null
  now: Date
  today: string
  onOpen: (id: string) => void
}) {
  const next = nextToday(rows, now)
  return (
    <div data-agenda className="flex min-h-full flex-col">
      {byDay(rows).map((g) => (
        <section
          key={g.day}
          aria-label={g.day === today ? 'Today' : g.day}
          className="flex shrink-0 border-b border-rule"
        >
          <div className={cn(MARGIN, 'flex justify-center pt-2.5')}>
            <DateLeaf day={g.day} today={today} />
          </div>
          <ol className="flex min-w-0 flex-1 flex-col">
            {g.meetings.map((m) => (
              <AgendaRow
                key={m.id}
                meeting={m}
                now={now}
                next={next}
                everyone={everyone}
                open={m.id === open}
                onOpen={() => onOpen(m.id)}
              />
            ))}
          </ol>
        </section>
      ))}
      {later.length === 0 ? (
        <div aria-hidden className="flex flex-1">
          <div className={MARGIN} />
        </div>
      ) : (
        <Later rows={later} open={open} today={today} onOpen={onOpen} />
      )}
    </div>
  )
}

/**
 * `Later n … to 14 Dec`: the meetings after the two weeks, folded. Unfolded,
 * a band per month with its count, its rows one line each, three, then
 * `7 more in November`, which unfolds in place.
 */
function Later({
  rows,
  open,
  today,
  onOpen,
}: {
  rows: ReadonlyArray<ListedMeeting>
  open: string | null
  today: string
  onOpen: (id: string) => void
}) {
  const id = useId()
  const [unfolded, setUnfolded] = useState(false)
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set())
  return (
    <section data-later aria-label="Later">
      <FoldBand
        row
        label="Later"
        count={rows.length}
        open={unfolded}
        onOpenChange={setUnfolded}
        controls={id}
        {...(unfolded ? {} : { end: laterEnd(rows, today) })}
      />
      <div id={id} hidden={!unfolded}>
        {unfolded
          ? laterMonths(rows, today).map((month) => {
              const all = whole.has(month.key)
              const shown = all ? month.rows : month.rows.slice(0, LATER_SHOWN)
              const hidden = month.rows.length - shown.length
              return (
                <section key={month.key} aria-label={month.label}>
                  <Band
                    label={
                      <>
                        {month.label}{' '}
                        <span className="ml-1 text-foreground">
                          {month.rows.length}
                        </span>
                      </>
                    }
                    className="px-3"
                  />
                  <ol>
                    {shown.map((m) => (
                      <LaterRow
                        key={m.id}
                        meeting={m}
                        open={m.id === open}
                        onOpen={() => onOpen(m.id)}
                      />
                    ))}
                  </ol>
                  {hidden > 0 ? (
                    <FoldRow
                      hidden={hidden}
                      noun={`more in ${month.label}`}
                      onShow={() =>
                        setWhole((prev) => new Set([...prev, month.key]))
                      }
                      className="h-8 border-t-0 border-b pl-17"
                    />
                  ) : null}
                </section>
              )
            })
          : null}
      </div>
    </section>
  )
}

/**
 * Past in its bands: `No write-up n` first, then `This week`, `Last week`
 * and a band per month. The `No write-up` count is the server's, over every
 * page; while the search or a filter is on every band reads its count, the
 * server's too. After `Jump to` there is no `No write-up` band: an owing
 * row sits in its month.
 */
function PastList({
  rows,
  unwritten,
  bands,
  jumped,
  open,
  today,
  onOpen,
}: {
  rows: ReadonlyArray<ListedMeeting>
  unwritten: number
  bands: Readonly<Record<string, number>> | null
  jumped: boolean
  open: string | null
  today: string
  onOpen: (id: string) => void
}) {
  return (
    <div data-past>
      {pastBands(rows, today, !jumped).map((b) => {
        const count =
          bands !== null
            ? (bands[b.key] ?? b.rows.length)
            : b.key === 'unwritten'
              ? unwritten
              : null
        return (
          <section key={b.key} aria-label={b.label}>
            <Band
              label={
                count === null ? (
                  b.label
                ) : (
                  <>
                    {b.label}{' '}
                    <span className="ml-1 text-foreground">{count}</span>
                  </>
                )
              }
              className="px-3"
            />
            <ol>
              {b.rows.map((m) => (
                <PastRow
                  key={m.id}
                  meeting={m}
                  today={today}
                  open={m.id === open}
                  onOpen={() => onOpen(m.id)}
                />
              ))}
            </ol>
          </section>
        )
      })}
    </div>
  )
}
