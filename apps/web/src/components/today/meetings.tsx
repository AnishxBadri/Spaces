import { Link } from '@tanstack/react-router'
import { Fragment, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { LedgerRow, SectionHead } from '#/components/ledger-section'
import { nowLabel, useNow } from '#/components/today/day-strip'
import { TodayMeetingRow } from '#/components/today/today-meeting-row'
import { Twinkle } from '#/components/twinkle'
import { Button } from '#/components/ui/button'
import { listDayMeetings } from '#/lib/server-fns'
import type { SetupAudience, TodayMeeting } from '#/lib/server-fns'
import {
  dayTense,
  dayWindow,
  isUpcoming,
  nowIndex,
  waitFor,
} from '#/lib/meetings/day'
import { adminNames } from '#/lib/setup/whats-set-up'

/** A day's meetings: null while read, `failed` when the read failed. */
export type DayMeetings = ReadonlyArray<TodayMeeting> | 'failed' | null

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
    meetings: ReadonlyArray<TodayMeeting> | 'failed'
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

/**
 * Between what has started and what is ahead: a pine square, `Now · 11:40`,
 * a hairline, and the wait to the next meeting when there is one.
 */
function NowRule({ now, next }: { now: Date; next: TodayMeeting | null }) {
  return (
    <li
      data-now-rule
      className="flex h-6 items-center gap-2 border-b border-rule px-(--inset)"
    >
      <span aria-hidden className="size-1.5 shrink-0 bg-primary" />
      <span className="shrink-0 mono text-micro text-foreground">
        {nowLabel(now)}
      </span>
      <span aria-hidden className="flex-1 border-t border-hairline" />
      {next === null ? null : (
        <span className="shrink-0 mono text-micro text-graphite">
          Next in {waitFor(Date.parse(next.startsAt) - now.getTime())}
        </span>
      )}
    </li>
  )
}

/** A line under the head that is not a meeting: a state, said once. */
function StateRow({ children }: { children: ReactNode }) {
  return <LedgerRow className="gap-2">{children}</LedgerRow>
}

/**
 * Today's Meetings: the day the strip's head picked, a now-rule on today,
 * Write after a meeting and Prep before one. With no calendar connected it
 * is the one line that says so.
 * - External meetings only: internal ones are never stored.
 * - The day's count, its nav and `All meetings ›` are the strip's head
 *   (`DayStrip`), drawn whenever a calendar is, so this head is the title.
 */
export function MeetingsSection({
  calendar,
  audience,
  today,
  day,
  meetings,
  preparing,
  onOpen,
  onRetry,
}: {
  calendar: boolean
  audience: SetupAudience
  today: string
  day: string
  meetings: DayMeetings
  /** The meeting whose Prep is running in its window; null when none. */
  preparing: string | null
  /** Opens the meeting window; `prep` starts Prep in it. */
  onOpen: (id: string, prep: boolean) => void
  /** Reads the day again after a failed read. */
  onRetry: () => void
}) {
  const now = useNow()
  if (!calendar)
    return (
      <section aria-label="Meetings" className="flex flex-col">
        <SectionHead title="Meetings" />
        <ol>
          <StateRow>
            {audience.isAdmin ? (
              <>
                <span
                  data-needs-setup="admin"
                  className="min-w-0 truncate text-ui text-graphite"
                >
                  No calendar connected
                </span>
                <Link
                  to="/settings/email-calendar"
                  className="focus-ring shrink-0 text-label text-foreground hover:underline"
                >
                  Connect Google ›
                </Link>
              </>
            ) : (
              <span
                data-needs-setup="member"
                className="min-w-0 truncate text-ui text-graphite"
              >
                Ask {adminNames(audience.admins)} to connect Google
              </span>
            )}
          </StateRow>
        </ol>
      </section>
    )
  const rows = meetings === 'failed' ? null : meetings
  const tense = dayTense(day, today)
  const rule =
    rows !== null && now !== null && tense === 'today'
      ? nowIndex(rows, now)
      : null
  const next =
    rows === null || now === null
      ? null
      : (rows.find((m) => !m.cancelled && isUpcoming(m, now)) ?? null)
  const nowRule =
    now === null ? null : <NowRule key="now-rule" now={now} next={next} />
  return (
    <section aria-label="Meetings" className="flex flex-col">
      <SectionHead title="Meetings" />
      <ol>
        {meetings === 'failed' ? (
          <StateRow>
            <span aria-hidden className="size-1.5 shrink-0 bg-destructive" />
            <span
              data-meetings-failed
              className="min-w-0 flex-1 truncate text-ui text-foreground"
            >
              Could not read the calendar · Google did not answer
            </span>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </StateRow>
        ) : rows === null ? (
          <StateRow>
            <Twinkle label="Reading meetings" />
          </StateRow>
        ) : rows.length === 0 ? (
          <StateRow>
            <span className="text-ui text-graphite">No meetings</span>
          </StateRow>
        ) : (
          rows.map((m, i) => (
            <Fragment key={m.id}>
              {rule === i ? nowRule : null}
              <TodayMeetingRow
                meeting={m}
                tense={tense}
                now={now}
                preparing={preparing === m.id}
                onOpen={onOpen}
              />
            </Fragment>
          ))
        )}
        {rows !== null && rows.length > 0 && rule === rows.length
          ? nowRule
          : null}
      </ol>
    </section>
  )
}
