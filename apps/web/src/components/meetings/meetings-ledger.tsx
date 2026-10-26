import { dayKey } from '@spaces/core/format'
import { LabelHead, LedgerRow } from '#/components/ledger-section'
import { MeetingRow, PrepButton } from '#/components/meetings/meeting-row'
import { WriteUpButton } from '#/components/meetings/write-up-button'
import { NeedsSetup } from '#/components/needs-setup'
import type {
  ListedMeeting,
  MeetingsList,
  SetupAudience,
} from '#/lib/server-fns'
import { RSVP_WORD, timeSpan } from '#/lib/meetings/day'
import {
  byDay,
  dayHead,
  filterMeetings,
  needsWriteUp,
  PAST_SHOWN_NOTE,
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
  /** The loader's instant, for the Today and Tomorrow heads and the past lane. */
  now: string
  /** Opens the meeting window; `prep` starts Prep in it. */
  onOpen: (id: string, prep: boolean) => void
}) {
  const shown = filterMeetings(list, filter)
  const today = dayKey(now)
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
          <LabelHead label="Past" />
          <ol>
            {shown.past.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                when={pastWhen(m.startsAt, now)}
                lane={writeUpWord(m)}
                action={
                  needsWriteUp(m) ? (
                    <WriteUpButton interactionId={m.id} />
                  ) : null
                }
                onOpen={() => onOpen(m.id, false)}
              />
            ))}
            {list.more ? (
              <LedgerRow last>
                <span className="mono text-micro text-graphite">
                  {PAST_SHOWN_NOTE}
                </span>
              </LedgerRow>
            ) : null}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

/** An upcoming row: Prep opens the window with Prep running. */
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
      when={timeSpan(meeting.startsAt, meeting.endsAt)}
      lane={
        meeting.cancelled
          ? 'cancelled'
          : meeting.myRsvp === null
            ? ''
            : RSVP_WORD[meeting.myRsvp]
      }
      action={
        meeting.cancelled ? null : (
          <PrepButton onPrep={() => onOpen(meeting.id, true)} />
        )
      }
      onOpen={() => onOpen(meeting.id, false)}
    />
  )
}
