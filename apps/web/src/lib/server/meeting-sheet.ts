import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

export type {
  CallPlace,
  MeetingSheetExtras,
  RecentRow,
  ReplyDraw,
  SheetPerson,
} from '../meetings/sheet'
export type { MeetingRemoval } from '../meetings/removal'
export type { MeetingSheetData } from '../interactions/meeting-sheet-read'

const meetingId = Schema.String.check(Schema.isUUID())

/**
 * The meeting sheet's read, in the Meetings page's pane and in the meeting
 * window, with what `Remove from Spaces…` needs (null when it is not the
 * reader's to remove). The programs are imported inside the handler so
 * their database code never reaches the client bundle.
 */
export const getMeetingSheet = createServerFn()
  .validator(input(Schema.Struct({ id: meetingId })))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { meetingSheetProgram } =
      await import('../interactions/meeting-sheet-read')
    const { meetingRemovalProgram } =
      await import('../interactions/meeting-remove')
    const { meetingMessage } = await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    try {
      const [sheet, removal] = await Promise.all([
        effectFn(meetingSheetProgram)({ id: user.id }, data.id),
        effectFn(meetingRemovalProgram)(
          { id: user.id, email: user.email, role: user.role ?? 'member' },
          data.id,
        ),
      ])
      return { ...sheet, removal }
    } catch (failure) {
      throw new Error(meetingMessage(failure))
    }
  })

/**
 * `Remove from Spaces…`: the meeting, or with `series` its whole series,
 * out of Spaces and remembered. Its attendees and admins only.
 */
export const removeMeeting = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        id: meetingId,
        scope: Schema.Literals(['meeting', 'series']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { removeMeetingProgram, removeMessage } =
      await import('../interactions/meeting-remove')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(removeMeetingProgram)(
        { id: user.id, email: user.email, role: user.role ?? 'member' },
        data.id,
        data.scope,
      )
    } catch (failure) {
      throw new Error(removeMessage(failure))
    }
  })
