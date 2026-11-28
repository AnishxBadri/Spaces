import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'
import { MONTH, MeetingsFiltersSchema } from '../meetings/filter'

export type {
  ArtifactRole,
  DayMeeting,
  MeetingParticipant,
  MeetingRecord,
  PrepEvent,
  TodayMeeting,
} from '../meetings/day'
export type {
  MeetingArtifact,
  MeetingCarriedNote,
  MeetingDetail,
  MeetingSuggestion,
  UnwrittenMeeting,
} from '../interactions/meeting-read'
export type { RecorderLink } from '../interactions/recorder-links'
export type { MeetingFacets } from '../interactions/meeting-read'

const uuid = Schema.String.check(Schema.isUUID())

/**
 * An ISO instant in UTC: a real calendar day, `T`, hours and minutes, then
 * optional seconds and fraction, then `Z`. An offset or a local time is
 * refused.
 */
const isoInstant = Schema.String.check(
  Schema.isPattern(
    /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-8])))T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/,
    { expected: 'an ISO date-time in UTC' },
  ),
)

/**
 * The meeting surfaces' server fns: Today's Meetings section, the Meetings
 * page, the meeting window, pinning a record and Prep.
 * Programs are imported inside the handlers so their database code never
 * reaches the client bundle.
 */

/** The meetings starting in one local day, `[from, to)` from the browser. */
export const listDayMeetings = createServerFn()
  .validator(input(Schema.Struct({ from: isoInstant, to: isoInstant })))
  .handler(async ({ data }) => {
    await requireUser()
    const { dayMeetingsProgram } = await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    return effectFn(dayMeetingsProgram)(new Date(data.from), new Date(data.to))
  })

/**
 * Today's meeting reads that need no clock from the browser: whether a
 * calendar is connected, who a member asks, and the reader's past meetings
 * nobody wrote up.
 */
export const getTodayMeetings = createServerFn().handler(async () => {
  const user = await requireUser()
  const { calendarConnectedProgram, unwrittenMeetingsProgram } =
    await import('../interactions/meeting-read')
  const { setupAudienceProgram } = await import('../integrations/setup-status')
  const { effectFn } = await import('./effect')
  const [calendar, audience, unwritten] = await Promise.all([
    effectFn(calendarConnectedProgram)(),
    effectFn(setupAudienceProgram)(user.role ?? 'member'),
    effectFn(unwrittenMeetingsProgram)(
      { id: user.id, email: user.email },
      new Date(),
    ),
  ])
  return { calendar, audience, unwritten }
})

/** The Meetings list's params, the page's cursor aside. */
const meetingsListFields = {
  tab: Schema.Literals(['upcoming', 'past']),
  whose: Schema.Literals(['mine', 'everyone']),
  now: isoInstant,
  until: isoInstant,
  q: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  filters: Schema.optional(MeetingsFiltersSchema),
  month: Schema.optional(Schema.String.check(Schema.isPattern(MONTH))),
  tz: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+\-/]{1,64}$/)),
  ),
}

/**
 * The Meetings page: one tab of the list for one params object, with
 * whether a calendar is connected, who a member asks, and whether the
 * workspace has more than one member (the `Mine · Everyone` control). The
 * browser sends both instants and its time zone, so "this week and next"
 * and `Jump to`'s months are the reader's.
 */
export const listMeetings = createServerFn()
  .validator(
    input(
      Schema.Struct({
        ...meetingsListFields,
        cursor: Schema.optional(
          Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,400}$/)),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { calendarConnectedProgram, meetingListProgram } =
      await import('../interactions/meeting-read')
    const { setupAudienceProgram } =
      await import('../integrations/setup-status')
    const { effectFn } = await import('./effect')
    const [calendar, audience, list] = await Promise.all([
      effectFn(calendarConnectedProgram)(),
      effectFn(setupAudienceProgram)(user.role ?? 'member'),
      effectFn(meetingListProgram)({ id: user.id, email: user.email }, data),
    ])
    const { members, ...page } = list
    return { calendar, audience, team: members > 1, ...page }
  })

/** The Meetings Filter panel's counts and `Jump to`'s months. */
export const listMeetingFacets = createServerFn()
  .validator(input(Schema.Struct(meetingsListFields)))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { meetingFacetsProgram } =
      await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    return effectFn(meetingFacetsProgram)(
      { id: user.id, email: user.email },
      data,
    )
  })

const byId = Schema.Struct({ id: uuid })

/** The meeting window's read. */
export const getMeeting = createServerFn()
  .validator(input(byId))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { meetingDetailProgram, meetingMessage } =
      await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(meetingDetailProgram)({ id: user.id }, data.id)
    } catch (failure) {
      throw new Error(meetingMessage(failure))
    }
  })

/** Pin a record to a meeting: the one manual edge. */
export const pinMeetingRecord = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ interactionId: uuid, entityId: uuid })))
  .handler(async ({ data }) => {
    await requireUser()
    const { meetingMessage, pinMeetingRecordProgram } =
      await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(pinMeetingRecordProgram)(
        data.interactionId,
        data.entityId,
      )
    } catch (failure) {
      throw new Error(meetingMessage(failure))
    }
  })

/** Prep, streamed as `PrepEvent`s; nothing is stored. */
export const prepMeeting = createServerFn({ method: 'POST' })
  .validator(input(Schema.Struct({ interactionId: uuid })))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { prepStream } = await import('../interactions/meeting-prep')
    return prepStream({ userId: user.id, interactionId: data.interactionId })
  })

/** "Save as note": the brief, filed on the meeting's records. */
export const savePrepAsNote = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        interactionId: uuid,
        markdown: Schema.Trim.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(200_000),
        ),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { savePrepNoteProgram } = await import('../interactions/meeting-prep')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(savePrepNoteProgram)(
        user.id,
        data.interactionId,
        data.markdown,
      )
    } catch (failure) {
      throw new Error(
        failure instanceof Error && failure.message
          ? failure.message
          : 'Could not save the note',
      )
    }
  })
