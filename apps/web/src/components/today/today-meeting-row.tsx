import { formatTime } from '@spaces/core/format'
import { PrepButton } from '#/components/meetings/meeting-row'
import { WriteUpButton } from '#/components/meetings/write-up-button'
import { MoreMenu } from '#/components/ui/more-menu'
import type { MoreMenuEntry } from '#/components/ui/more-menu'
import { googleDayUrl, whoLine } from '#/lib/meetings/day'
import type { DayTense, TodayMeeting } from '#/lib/meetings/day'
import { cn } from '#/lib/utils'

/** Where a meeting stands against the reader's clock. */
type When = 'ended' | 'running' | 'ahead' | 'unknown'

function whenOf(m: TodayMeeting, tense: DayTense, now: Date | null): When {
  if (tense === 'past') return 'ended'
  if (tense === 'future') return 'ahead'
  if (now === null) return 'unknown'
  if (Date.parse(m.endsAt) <= now.getTime()) return 'ended'
  return Date.parse(m.startsAt) > now.getTime() ? 'ahead' : 'running'
}

/** The row's action: Write after it, Prep before it, a word while Prep runs. */
function Action({
  meeting,
  when,
  preparing,
  onPrep,
}: {
  meeting: TodayMeeting
  when: When
  preparing: boolean
  onPrep: () => void
}) {
  if (meeting.cancelled)
    return <span className="text-label text-graphite">Cancelled</span>
  if (preparing)
    return (
      <span data-preparing className="text-label text-graphite">
        Preparing…
      </span>
    )
  if (when === 'ahead') return <PrepButton onPrep={onPrep} />
  if (when === 'ended' && meeting.noteId === null)
    return <WriteUpButton interactionId={meeting.id} />
  return null
}

/**
 * One meeting on Today: the start time, the title (graphite once it has
 * ended), the action, who outside the workspace it is with, an empty figure
 * lane and the row's `···`. The row opens the meeting window.
 */
export function TodayMeetingRow({
  meeting,
  tense,
  now,
  preparing,
  onOpen,
}: {
  meeting: TodayMeeting
  /** The shown day against today. */
  tense: DayTense
  /** The browser's clock; null before it is read. */
  now: Date | null
  /** Prep is running for this meeting in its window. */
  preparing: boolean
  /** Opens the meeting window; `prep` starts Prep in it. */
  onOpen: (id: string, prep: boolean) => void
}) {
  const when = whenOf(meeting, tense, now)
  const title = meeting.title ?? 'Meeting'
  const menu: Array<MoreMenuEntry> = [
    { label: 'Open in Google Calendar', href: googleDayUrl(meeting.startsAt) },
    {
      label: 'Copy link',
      copy: () =>
        `${window.location.origin}/meetings?modal=meeting&id=${meeting.id}`,
    },
  ]
  return (
    <li
      data-row
      data-today-meeting={meeting.cancelled ? 'cancelled' : when}
      className="group flex h-ledger-row items-center gap-3 border-b border-rule px-3 transition-colors duration-150 ease-out-quart hover:bg-bone"
    >
      <button
        type="button"
        onClick={() => onOpen(meeting.id, false)}
        className="focus-ring-inset flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
      >
        <span
          className={cn(
            'w-22.5 shrink-0 mono text-micro text-graphite',
            meeting.cancelled && 'line-through',
          )}
        >
          {formatTime(meeting.startsAt)}
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-body',
            meeting.cancelled || when === 'ended'
              ? 'text-graphite'
              : 'text-foreground',
            meeting.cancelled && 'line-through',
          )}
        >
          {title}
        </span>
      </button>
      <span className="flex w-30 shrink-0 items-center">
        <Action
          meeting={meeting}
          when={when}
          preparing={preparing}
          onPrep={() => onOpen(meeting.id, true)}
        />
      </span>
      <span className="w-30 shrink-0 truncate text-label text-graphite">
        {whoLine(meeting.external)}
      </span>
      <span className="w-12 shrink-0" />
      <span className="flex w-6 shrink-0 items-center justify-center">
        <MoreMenu variant="row" label={title} items={menu} />
      </span>
    </li>
  )
}
