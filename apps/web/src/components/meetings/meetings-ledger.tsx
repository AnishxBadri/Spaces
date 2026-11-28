import { DitherNoun } from '#/components/dither-noun'
import { Band } from '#/components/ledger-section'
import { DateLeaf } from '#/components/meetings/date-leaf'
import { AgendaRow, PastRow } from '#/components/meetings/meeting-row'
import { NeedsSetup } from '#/components/needs-setup'
import { ListFoot } from '#/components/table/list-foot'
import type { ListFootPage } from '#/components/table/list-foot'
import { ListErrorRow, ListLoadingRow } from '#/components/table/list-states'
import { byDay, nextToday, pastBands, PAST_STEP } from '#/lib/meetings/list'
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

/** `7 meetings`, grouped and never compact. */
const meetingsWord = (n: number) =>
  `${n.toLocaleString('en-US')} meeting${n === 1 ? '' : 's'}`

/** What the list pane is drawing. */
export type LedgerState =
  | { kind: 'loading' }
  | { kind: 'failed'; onRetry: () => void }
  | {
      kind: 'loaded'
      rows: ReadonlyArray<ListedMeeting>
      counts: MeetingCounts
      calendar: boolean
      audience: SetupAudience
      /** Past's next page; absent on Upcoming. */
      page?: Omit<ListFootPage, 'step'> | undefined
    }

/**
 * The Meetings list pane's body and foot: Upcoming as an agenda, each day's
 * leaf in a bone margin beside its rows, or Past in bands; the loading,
 * failed and empty states in their place; the foot with the tab's count.
 */
export function MeetingsLedger({
  tab,
  state,
  everyone,
  open,
  now,
  today,
  onOpen,
}: {
  tab: MeetingsTab
  state: LedgerState
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
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {state.kind === 'loading' ? (
          <ListLoadingRow plural="Meetings" />
        ) : state.kind === 'failed' ? (
          <ListErrorRow
            plural="Meetings"
            line="The database did not answer."
            onRetry={state.onRetry}
          />
        ) : state.rows.length === 0 ? (
          <Empty
            tab={tab}
            calendar={state.calendar}
            audience={state.audience}
          />
        ) : tab === 'upcoming' ? (
          <Agenda
            rows={state.rows}
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
            open={open}
            today={today}
            onOpen={onOpen}
          />
        )}
      </div>
      <ListFoot
        {...(total === null || total === 0
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
 * margin running on to the foot under the last day.
 */
function Agenda({
  rows,
  everyone,
  open,
  now,
  today,
  onOpen,
}: {
  rows: ReadonlyArray<ListedMeeting>
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
      <div aria-hidden className="flex flex-1">
        <div className={MARGIN} />
      </div>
    </div>
  )
}

/**
 * Past in its bands: `No write-up n` first, then `This week`, `Last week`
 * and a band per month. The `No write-up` count is the server's, over every
 * page.
 */
function PastList({
  rows,
  unwritten,
  open,
  today,
  onOpen,
}: {
  rows: ReadonlyArray<ListedMeeting>
  unwritten: number
  open: string | null
  today: string
  onOpen: (id: string) => void
}) {
  return (
    <div data-past>
      {pastBands(rows, today).map((b) => (
        <section key={b.key} aria-label={b.label}>
          <Band
            label={
              b.key === 'unwritten' ? (
                <>
                  {b.label}{' '}
                  <span className="ml-1 text-foreground">{unwritten}</span>
                </>
              ) : (
                b.label
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
      ))}
    </div>
  )
}
