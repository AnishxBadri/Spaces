import { useEffect, useState } from 'react'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { DensityRamp } from '#/components/dither'
import { NeedsSetup } from '#/components/needs-setup'
import { nowLabel, useNow } from '#/components/today/day-strip'
import { Button } from '#/components/ui/button'
import { listDayMeetings } from '#/lib/server-fns'
import type { DayMeeting, SetupAudience } from '#/lib/server-fns'
import {
  artifactMarks,
  dayLabel,
  dayWindow,
  isUpcoming,
  nowIndex,
  participantName,
  RSVP_MARK,
  RSVP_WORD,
  shiftDay,
  timeSpan,
} from '#/lib/meetings/day'
import { cn } from '#/lib/utils'

/** A day's meetings: null while read, `failed` when the read failed. */
export type DayMeetings = ReadonlyArray<DayMeeting> | 'failed' | null

/**
 * One local day's meetings, read in the browser so the day and the times are
 * the reader's clock. Never read for a null day. `version` re-reads after a
 * write in the meeting window, and after a retry.
 */
export function useDayMeetings(
  day: string | null,
  version: number,
): DayMeetings {
  const [state, setState] = useState<{
    day: string
    version: number
    meetings: ReadonlyArray<DayMeeting> | 'failed'
  } | null>(null)
  useEffect(() => {
    if (day === null) return
    let alive = true
    void listDayMeetings({ data: dayWindow(day) })
      .then((meetings) => {
        if (alive) setState({ day, version, meetings })
      })
      .catch(() => {
        // A failed read is not an empty day.
        if (alive) setState({ day, version, meetings: 'failed' })
      })
    return () => {
      alive = false
    }
  }, [day, version])
  if (state === null || state.day !== day) return null
  // A retry reads again from the failed state; a refresh keeps the rows.
  if (state.meetings === 'failed' && state.version !== version) return null
  return state.meetings
}

/** `‹ today ›`: the day before, the day shown, the day after. */
function DayNav({
  day,
  today,
  onDay,
}: {
  day: string
  today: string
  onDay: (day: string) => void
}) {
  const step =
    'focus-ring px-1 text-graphite transition-colors duration-150 ease-out-quart hover:text-foreground'
  return (
    <div
      role="group"
      aria-label="Day"
      className="flex shrink-0 items-baseline mono text-micro"
    >
      <button
        type="button"
        aria-label="Previous day"
        className={step}
        onClick={() => onDay(shiftDay(day, -1))}
      >
        ‹
      </button>
      {day === today ? (
        <span className="px-1 text-foreground">{dayLabel(day, today)}</span>
      ) : (
        <button
          type="button"
          title="Back to today"
          className={cn(step, 'text-foreground')}
          onClick={() => onDay(today)}
        >
          {dayLabel(day, today)}
        </button>
      )}
      <button
        type="button"
        aria-label="Next day"
        className={step}
        onClick={() => onDay(shiftDay(day, 1))}
      >
        ›
      </button>
    </div>
  )
}

/** The pine rule between what has started and what is ahead. */
function NowRule({ now }: { now: Date }) {
  return (
    <li data-now-rule aria-hidden className="relative h-0">
      <span className="absolute inset-x-0 -top-px border-t border-primary" />
      <span className="absolute -top-2 right-3 bg-paper pl-2 mono text-field text-primary">
        {nowLabel(now)}
      </span>
    </li>
  )
}

/** Names with their RSVP marks: `Ana Reyes ✓ · ben@flent.io ?`. */
function Participants({ meeting }: { meeting: DayMeeting }) {
  if (meeting.participants.length === 0) return null
  return (
    <span className="min-w-0 truncate text-label text-graphite">
      {meeting.participants.map((p, i) => (
        <span key={p.email}>
          {i > 0 ? ' · ' : ''}
          {participantName(p)}{' '}
          <span className="mono" title={RSVP_WORD[p.rsvp]}>
            {RSVP_MARK[p.rsvp]}
          </span>
        </span>
      ))}
    </span>
  )
}

function MeetingRow({
  meeting,
  now,
  onOpen,
}: {
  meeting: DayMeeting
  now: Date | null
  onOpen: (id: string, prep: boolean) => void
}) {
  const ahead = now !== null && !meeting.cancelled && isUpcoming(meeting, now)
  const marks = meeting.cancelled
    ? 'cancelled'
    : artifactMarks(meeting.artifacts)
  return (
    <LedgerRow className="group/row">
      <button
        type="button"
        data-meeting-row
        onClick={() => onOpen(meeting.id, false)}
        className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone"
      >
        <span
          className={cn(
            'w-22 shrink-0 mono text-micro text-graphite',
            meeting.cancelled && 'line-through',
          )}
        >
          {timeSpan(meeting.startsAt, meeting.endsAt)}
        </span>
        <span
          className={cn(
            'min-w-0 shrink truncate text-body font-medium',
            meeting.cancelled && 'text-graphite line-through',
          )}
        >
          {meeting.title ?? 'Meeting'}
        </span>
        <Participants meeting={meeting} />
        <span className="flex-1" />
        {meeting.records.slice(0, 2).map((r) => (
          <span
            key={r.id}
            className="max-w-32 shrink-0 truncate rounded-none border border-rule px-1.5 text-label"
          >
            {r.name}
          </span>
        ))}
      </button>
      {ahead ? (
        <Button
          variant="outline"
          size="sm"
          title="Brief me on the linked records"
          onClick={() => onOpen(meeting.id, true)}
        >
          Prep
        </Button>
      ) : null}
      <span className="w-28 shrink-0 truncate text-right mono text-micro text-graphite">
        {marks}
      </span>
    </LedgerRow>
  )
}

/**
 * Today's Meetings: one day with `‹ today ›`, a now-rule on today, Prep on
 * what is ahead, and "all meetings ›" to the Meetings page. With no calendar
 * connected it is the one line that says so. (D79, D80)
 * - External meetings only: internal ones are never stored.
 * - The head's count is the day's count, and nothing else prints it.
 */
export function MeetingsSection({
  calendar,
  audience,
  today,
  day,
  onDay,
  meetings,
  onOpen,
  onRetry,
}: {
  calendar: boolean
  audience: SetupAudience
  today: string
  day: string
  onDay: (day: string) => void
  meetings: DayMeetings
  /** Opens the meeting window; `prep` starts Prep in it. */
  onOpen: (id: string, prep: boolean) => void
  /** Reads the day again after a failed read. */
  onRetry: () => void
}) {
  const now = useNow()
  if (!calendar)
    return (
      <section aria-label="Meetings" className="flex flex-col">
        <LabelHead label="Meetings" />
        <div className="flex h-ledger-row items-center px-3">
          <NeedsSetup
            needs="No calendar connected"
            action="Connect Google"
            to="/settings/email-calendar"
            thing="Google"
            audience={audience}
          />
        </div>
      </section>
    )
  const rows = meetings === 'failed' ? null : meetings
  const rule =
    rows !== null && now !== null && day === today ? nowIndex(rows, now) : null
  return (
    <section aria-label="Meetings" className="flex flex-col">
      <LabelHead
        label={
          <>
            Meetings
            {rows === null ? null : (
              <span className="ml-2.5 mono text-micro tracking-normal text-graphite">
                {rows.length}
              </span>
            )}
          </>
        }
      >
        <DayNav day={day} today={today} onDay={onDay} />
        {/* The Meetings page is its own route; a typed Link would refuse it until it exists. */}
        <a
          href="/meetings"
          className="focus-ring shrink-0 mono text-micro text-foreground hover:underline"
        >
          all meetings ›
        </a>
      </LabelHead>
      <ol>
        {meetings === 'failed' ? (
          <LedgerRow>
            <span
              data-meetings-failed
              className="mono text-micro text-graphite"
            >
              read failed
            </span>
            <button
              type="button"
              onClick={onRetry}
              className="focus-ring mono text-micro text-foreground hover:underline"
            >
              retry ›
            </button>
          </LedgerRow>
        ) : rows === null ? (
          <LedgerRow>
            <DensityRamp width={120} />
          </LedgerRow>
        ) : rows.length === 0 ? (
          <LedgerRow>
            <span className="text-ui text-graphite">No meetings.</span>
          </LedgerRow>
        ) : (
          rows.map((m, i) => (
            <MeetingRowWithRule
              key={m.id}
              meeting={m}
              now={now}
              rule={rule === i}
              onOpen={onOpen}
            />
          ))
        )}
        {rule !== null && rows !== null && rule === rows.length ? (
          now === null ? null : (
            <NowRule now={now} />
          )
        ) : null}
      </ol>
    </section>
  )
}

function MeetingRowWithRule({
  meeting,
  now,
  rule,
  onOpen,
}: {
  meeting: DayMeeting
  now: Date | null
  rule: boolean
  onOpen: (id: string, prep: boolean) => void
}) {
  return (
    <>
      {rule && now !== null ? <NowRule now={now} /> : null}
      <MeetingRow meeting={meeting} now={now} onOpen={onOpen} />
    </>
  )
}
