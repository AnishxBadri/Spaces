import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

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
export type {
  ListedMeeting,
  MeetingFilter,
  MeetingsList,
  WriteUpState,
} from '../meetings/list'

/**
 * The meeting surfaces' server fns: Today's Meetings section, the Meetings
 * page, the meeting window, pinning a record and Prep.
 * Programs are imported inside the handlers so their database code never
 * reaches the client bundle.
 */

/** The meetings starting in one local day, `[from, to)` from the browser. */
export const listDayMeetings = createServerFn()
  .validator(z.object({ from: z.iso.datetime(), to: z.iso.datetime() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { dayMeetingsProgram } = await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    return effectFn(dayMeetingsProgram)(new Date(data.from), new Date(data.to))
  })

/**
 * Today's meeting reads that need no clock from the browser: whether a
 * calendar is connected, who a member asks, and the past meetings nobody
 * wrote up.
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
    effectFn(unwrittenMeetingsProgram)(new Date()),
  ])
  return { calendar, audience, unwritten }
})

/**
 * The Meetings page: what starts in `(now, until)` and the past, with
 * whether a calendar is connected and who a member asks. The browser sends
 * both instants, so "this week and next" is the reader's.
 */
export const listMeetings = createServerFn()
  .validator(z.object({ now: z.iso.datetime(), until: z.iso.datetime() }))
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
      effectFn(meetingListProgram)(
        { id: user.id, email: user.email },
        new Date(data.now),
        new Date(data.until),
      ),
    ])
    return { calendar, audience, ...list }
  })

const byId = z.object({ id: z.uuid() })

/** The meeting window's read. */
export const getMeeting = createServerFn()
  .validator(byId)
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
  .validator(z.object({ interactionId: z.uuid(), entityId: z.uuid() }))
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
  .validator(z.object({ interactionId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { prepStream } = await import('../interactions/meeting-prep')
    return prepStream({ userId: user.id, interactionId: data.interactionId })
  })

/** "Save as note": the brief, filed on the meeting's records. */
export const savePrepAsNote = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      interactionId: z.uuid(),
      markdown: z.string().trim().min(1).max(200_000),
    }),
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
