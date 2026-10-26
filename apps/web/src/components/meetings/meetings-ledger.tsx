import { dayKey, formatTime } from '@spaces/core/format'
import { PluginMark } from '#/components/integrations/integration-ledger'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { MeetingRow, PrepButton } from '#/components/meetings/meeting-row'
import { WriteUpButton } from '#/components/meetings/write-up-button'
import { NeedsSetup } from '#/components/needs-setup'
import type {
  ListedMeeting,
  MeetingsList,
  SetupAudience,
} from '#/lib/server-fns'
import {
  byDay,
  dayHead,
  filterMeetings,
  needsWriteUp,
  pastWhen,
  writeUpWord,
} from '#/lib/meetings/list'
import type { MeetingFilter } from '#/lib/meetings/list'

/** The upcoming day groups, then the past, as the filter narrows them. */
export function MeetingsLedger({
  list,
  filter,
  now,
  onOpen,
}: {
  list: MeetingsList & { calendar: boolean; audience: SetupAudience }
  filter: MeetingFilter
  /** The loader's instant, for the Today head and the past lane. */
  now: string
  /** Opens the meeting window; `prep` starts Prep in it. */
  onOpen: (id: string, prep: boolean) => void
}) {
  const shown = filterMeetings(list, filter)
  const today = dayKey(now)
  // What the cut left out, under the past it belongs to.
  const earlier = filter === 'all' || filter === 'past' ? list.earlier : 0
  if (shown.upcoming.length === 0 && shown.past.length === 0)
    return (
      <ol>
        <LedgerRow last>
          {!list.calendar &&
          list.upcoming.length === 0 &&
          list.past.length === 0 ? (
            <NeedsSetup
              needs="No calendar connected"
              action="Connect Google"
              to="/settings/email-calendar"
              thing="Google"
              audience={list.audience}
            />
          ) : (
            <span className="text-ui text-graphite">
              {filter === 'unwritten'
                ? 'Every meeting is written up.'
                : 'No meetings.'}
            </span>
          )}
        </LedgerRow>
      </ol>
    )
  return (
    <div className="flex flex-col gap-8 pt-6">
      {byDay(shown.upcoming).map((group) => (
        <section
          key={group.day}
          aria-label={dayHead(group.day, today)}
          className="flex flex-col"
        >
          <LabelHead label={dayHead(group.day, today)} />
          <ol>
            {group.meetings.map((m) => (
              <UpcomingRow key={m.id} meeting={m} onOpen={onOpen} />
            ))}
          </ol>
        </section>
      ))}
      {shown.past.length > 0 ? (
        <section aria-label="Past" className="flex flex-col">
          <LabelHead label="PAST" />
          <ol>
            {shown.past.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                when={pastWhen(m.startsAt, now)}
                action={<PastLane meeting={m} />}
                onOpen={() => onOpen(m.id, false)}
              />
            ))}
            {earlier > 0 ? (
              <li
                data-meetings-earlier
                className="flex h-ledger-row items-center px-3 text-label text-graphite"
              >
                {earlier.toLocaleString('en-US')} earlier
              </li>
            ) : null}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

/**
 * A past row's end: `■ No write-up` with Write, the recorder's mark beside
 * `Write-up · 2 tasks`, or the state word alone.
 */
function PastLane({ meeting: m }: { meeting: ListedMeeting }) {
  const word = writeUpWord(m)
  if (needsWriteUp(m))
    return (
      <>
        <span
          data-meeting-state
          className="shrink-0 mono text-micro text-warning"
        >
          ■ {word}
        </span>
        <WriteUpButton interactionId={m.id} />
      </>
    )
  return (
    <span
      data-meeting-state
      className="flex w-40 shrink-0 items-center justify-end gap-2 truncate mono text-micro text-graphite"
    >
      {m.via === null ? null : (
        <span title={m.via} className="flex">
          <PluginMark name={m.via} />
        </span>
      )}
      {word}
    </span>
  )
}

/** An upcoming row: its start, and Prep, which opens the window running. */
function UpcomingRow({
  meeting,
  onOpen,
}: {
  meeting: ListedMeeting
  onOpen: (id: string, prep: boolean) => void
}) {
  return (
    <MeetingRow
      meeting={meeting}
      when={formatTime(meeting.startsAt)}
      action={
        meeting.cancelled ? (
          <span
            data-meeting-state
            className="shrink-0 mono text-micro text-graphite"
          >
            Cancelled
          </span>
        ) : (
          <PrepButton onPrep={() => onOpen(meeting.id, true)} />
        )
      }
      onOpen={() => onOpen(meeting.id, false)}
    />
  )
}
