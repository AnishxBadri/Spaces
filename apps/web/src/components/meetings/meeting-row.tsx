import { formatTime } from '@spaces/core/format'
import type { ReactNode } from 'react'
import { Meeting, Phone, Time, Video } from '#/components/icons'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { laterDay, pastDay, peopleLine, rowClock } from '#/lib/meetings/list'
import type { ListedMeeting } from '#/lib/meetings/list'
import { cn } from '#/lib/utils'

/**
 * The Meetings list's rows. A row has no `···` and no buttons: the whole
 * row opens the meeting, and the open meeting carries the actions. The
 * open row stands on bone with an ink bar at its left edge.
 */

/** A row's button: the open one on bone with its ink bar. */
function RowButton({
  id,
  open,
  onOpen,
  className,
  children,
}: {
  id: string
  open: boolean
  onOpen: () => void
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-meeting-row={id}
      aria-current={open ? 'true' : undefined}
      onClick={onOpen}
      className={cn(
        'focus-ring-inset relative flex w-full flex-col gap-0.5 px-3 py-2.25 text-left transition-colors duration-150 ease-out-quart',
        open
          ? 'bg-bone before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-hairline'
          : 'hover:bg-row-hover',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Line two's words: the people, then the record in ink. */
function WhoAndRecord({
  meeting: m,
  struck = false,
}: {
  meeting: ListedMeeting
  struck?: boolean
}) {
  const people = peopleLine(m.people)
  const record = m.record?.name ?? null
  return (
    // The people give way first: a long invite list never hides the record.
    <span className="flex min-w-0 flex-1 text-label text-graphite">
      <span className="min-w-0 truncate">{people}</span>
      {record === null ? null : (
        <span
          className={cn(
            'max-w-1/2 shrink-0 truncate whitespace-pre',
            !struck && 'text-foreground',
          )}
        >
          {people === '' ? record : ` · ${record}`}
        </span>
      )}
    </span>
  )
}

/**
 * An agenda row: the time and title, the length at the end; then the
 * people and the record, our member under `Everyone` when the reader is not
 * in it, and the camera when it has a call link. The next meeting today
 * reads `in 8m` by a pine clock, a live one `Now · 12m left` by a pine
 * square; a cancelled one is struck and ends on nothing.
 */
export function AgendaRow({
  meeting: m,
  now,
  next,
  everyone,
  open,
  onOpen,
}: {
  meeting: ListedMeeting
  /** The ticking clock, for `in 8m` and `Now · 12m left`. */
  now: Date
  /** The id of the next meeting today. */
  next: string | null
  /** The list holds the team's meetings, so a colleague's is named. */
  everyone: boolean
  open: boolean
  onOpen: () => void
}) {
  const clock = rowClock(m, now, next)
  const members = everyone && !m.mine ? m.members.join(', ') : ''
  return (
    <li
      data-agenda-row
      {...(m.cancelled ? { 'data-cancelled': '' } : {})}
      className="border-t border-rule first:border-t-0"
    >
      <RowButton id={m.id} open={open} onOpen={onOpen}>
        <span className="flex h-5 min-w-0 items-baseline gap-3">
          <span
            className={cn(
              'w-ledger-row shrink-0 mono text-label',
              m.cancelled
                ? 'text-graphite line-through'
                : 'font-medium text-foreground',
            )}
          >
            {formatTime(m.startsAt)}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ui',
              m.cancelled ? 'text-graphite line-through' : 'text-foreground',
              open && !m.cancelled && 'font-medium',
            )}
          >
            {m.title ?? 'Meeting'}
          </span>
          {clock.kind === 'live' ? (
            <span
              data-meeting-clock="live"
              className="flex shrink-0 items-center gap-1.5 self-center"
            >
              <span aria-hidden className="size-2 shrink-0 bg-primary" />
              <span className="mono text-micro text-foreground">
                {clock.text}
              </span>
            </span>
          ) : clock.kind === 'next' ? (
            <span
              data-meeting-clock="next"
              className="flex shrink-0 items-center gap-1.5 self-center"
            >
              <Time aria-hidden className="shrink-0 text-primary" />
              <span className="mono text-micro text-foreground">
                {clock.text}
              </span>
            </span>
          ) : clock.kind === 'length' && clock.text !== null ? (
            <span className="shrink-0 mono text-micro text-graphite">
              {clock.text}
            </span>
          ) : null}
        </span>
        <span className="flex h-4 min-w-0 items-center gap-3 pl-13">
          <WhoAndRecord meeting={m} struck={m.cancelled} />
          {members === '' ? null : (
            <span
              data-meeting-members
              className="max-w-40 shrink-0 truncate text-label text-foreground"
            >
              {members}
            </span>
          )}
          {m.callLink && !m.cancelled ? (
            <Video
              aria-label="Has a call link"
              className="shrink-0 text-graphite"
            />
          ) : null}
        </span>
      </RowButton>
    </li>
  )
}

/**
 * A past row: the kind (a calendar, or a phone for a call), the title and
 * the day; then the people and the record; then, when the reader may read
 * the write-up, its summary, led by the recorder's mark when one wrote it.
 * A cancelled one, listed only when the filter shows them, is struck.
 */
export function PastRow({
  meeting: m,
  today,
  open,
  onOpen,
}: {
  meeting: ListedMeeting
  today: string
  open: boolean
  onOpen: () => void
}) {
  const Kind = m.kind === 'call' ? Phone : Meeting
  const who = peopleLine(m.people) !== '' || m.record !== null
  return (
    <li
      data-past-row
      {...(m.cancelled ? { 'data-cancelled': '' } : {})}
      className="border-b border-rule"
    >
      <RowButton id={m.id} open={open} onOpen={onOpen}>
        <span className="flex h-5 min-w-0 items-center gap-3">
          <Kind
            aria-label={m.kind === 'call' ? 'Call' : 'Meeting'}
            className="shrink-0 text-graphite"
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-ui',
              // Shown only under `Cancelled · Show`, struck as on the agenda.
              m.cancelled ? 'text-graphite line-through' : 'text-foreground',
              open && !m.cancelled && 'font-medium',
            )}
          >
            {m.title ?? (m.kind === 'call' ? 'Call' : 'Meeting')}
          </span>
          <span className="shrink-0 mono text-micro text-graphite">
            {pastDay(m.startsAt, today)}
          </span>
        </span>
        {who ? (
          <span className="flex min-w-0 pl-7">
            <WhoAndRecord meeting={m} />
          </span>
        ) : null}
        {m.summary === null ? null : (
          <span className="flex min-w-0 items-center gap-2 pl-7">
            {m.via === null ? null : (
              <span title={m.via} className="flex shrink-0">
                <PluginMark name={m.via} />
              </span>
            )}
            <span
              data-meeting-summary
              className="min-w-0 flex-1 truncate text-label text-graphite"
            >
              {m.summary}
            </span>
          </span>
        )}
      </RowButton>
    </li>
  )
}

/**
 * A row of Upcoming's `Later` fold: one 40px line with no leaf, the day in
 * mono (`Tue 3`), the time, the title and the record at the end. A
 * cancelled one is struck, as on the agenda.
 */
export function LaterRow({
  meeting: m,
  open,
  onOpen,
}: {
  meeting: ListedMeeting
  open: boolean
  onOpen: () => void
}) {
  return (
    <li
      data-later-row
      {...(m.cancelled ? { 'data-cancelled': '' } : {})}
      className="border-b border-rule"
    >
      <RowButton
        id={m.id}
        open={open}
        onOpen={onOpen}
        className="h-ledger-row flex-row items-baseline gap-3 pt-2.5 pb-0"
      >
        <span className="w-11 shrink-0 mono text-micro text-graphite">
          {laterDay(m.startsAt)}
        </span>
        <span
          className={cn(
            'w-10 shrink-0 mono text-label',
            m.cancelled
              ? 'text-graphite line-through'
              : 'font-medium text-foreground',
          )}
        >
          {formatTime(m.startsAt)}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-ui',
            m.cancelled ? 'text-graphite line-through' : 'text-foreground',
            open && !m.cancelled && 'font-medium',
          )}
        >
          {m.title ?? 'Meeting'}
        </span>
        {m.record === null ? null : (
          <span className="max-w-40 shrink-0 truncate text-label text-graphite">
            {m.record.name}
          </span>
        )}
      </RowButton>
    </li>
  )
}
