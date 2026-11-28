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
export type { MeetingSheetData } from '../interactions/meeting-sheet-read'

/**
 * The meeting sheet's read, in the Meetings page's pane and in the meeting
 * window. The program is imported inside the handler so its database code
 * never reaches the client bundle.
 */
export const getMeetingSheet = createServerFn()
  .validator(input(Schema.Struct({ id: Schema.String.check(Schema.isUUID()) })))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { meetingSheetProgram } =
      await import('../interactions/meeting-sheet-read')
    const { meetingMessage } = await import('../interactions/meeting-read')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(meetingSheetProgram)({ id: user.id }, data.id)
    } catch (failure) {
      throw new Error(meetingMessage(failure))
    }
  })
