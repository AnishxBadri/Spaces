import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

export type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
} from '../interactions/email-read'

/**
 * The email window's read. (D67)
 * The program is imported inside the handler so its sanitizer and database
 * code never reach the client bundle.
 */
export const getEmail = createServerFn()
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { emailDetailProgram, emailMessage } =
      await import('../interactions/email-read')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(emailDetailProgram)({ id: user.id }, data.id)
    } catch (failure) {
      throw new Error(emailMessage(failure))
    }
  })
