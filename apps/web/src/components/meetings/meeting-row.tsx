import type { ReactNode } from 'react'
import { LedgerRow } from '#/components/ledger-section'
import { Button } from '#/components/ui/button'
import type { DayMeeting } from '#/lib/server-fns'
import { participantName, RSVP_MARK, RSVP_WORD } from '#/lib/meetings/day'
import { cn } from '#/lib/utils'

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

/**
 * One meeting as a 40px ledger row: time, title, participants with their
 * RSVP marks and record chips, then the row's one action and its mono lane.
 * The row itself opens the meeting window; a cancelled meeting is struck.
 */
export function MeetingRow({
  meeting,
  when,
  lane,
  action,
  onOpen,
}: {
  meeting: DayMeeting
  /** The time lane: `09:30–10:00`, or a past row's `8 Oct`. */
  when: string
  /** The state word the row ends on; omitted, the action ends the row. */
  lane?: string | undefined
  /** Prep or Write, when the row has one. */
  action?: ReactNode
  onOpen: () => void
}) {
  return (
    <LedgerRow className="group/row">
      <button
        type="button"
        data-meeting-row
        onClick={onOpen}
        className="focus-ring-inset -mx-3 flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left hover:bg-bone"
      >
        <span
          className={cn(
            'w-22 shrink-0 mono text-micro text-graphite',
            meeting.cancelled && 'line-through',
          )}
        >
          {when}
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
      {action ?? null}
      {lane === undefined ? null : (
        <span className="w-28 shrink-0 truncate text-right mono text-micro text-graphite">
          {lane}
        </span>
      )}
    </LedgerRow>
  )
}

/** Prep on an upcoming row: opens the window with Prep already running. */
export function PrepButton({ onPrep }: { onPrep: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      title="Brief me on the linked records"
      onClick={onPrep}
    >
      Prep
    </Button>
  )
}
