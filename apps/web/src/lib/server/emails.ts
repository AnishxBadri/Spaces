import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

export type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
} from '../interactions/email-read'
export type { EmailPrivacy } from '../interactions/email-privacy'

/**
 * The email window's read and its privacy writes. (D67)
 * The programs are imported inside the handlers so their sanitizer and
 * database code never reach the client bundle.
 */
export const getEmail = createServerFn()
  .validator(
    z.object({ id: z.uuid(), recordId: z.uuid().nullable().default(null) }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { emailDetailProgram, emailMessage } =
      await import('../interactions/email-read')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(emailDetailProgram)(
        { id: user.id },
        data.id,
        data.recordId,
      )
    } catch (failure) {
      throw new Error(emailMessage(failure))
    }
  })

/**
 * The widen dialog's save, by the email's owner: the members granted this
 * email and, opened from a record, the override there.
 */
export const setEmailAudience = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      interactionId: z.uuid(),
      userIds: z.array(z.string().min(1)).max(200),
      record: z
        .object({ id: z.uuid(), workspace: z.boolean() })
        .nullable()
        .default(null),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { setEmailAudienceProgram, emailPrivacyMessage } =
      await import('../interactions/email-privacy')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(setEmailAudienceProgram)({ id: user.id }, data)
      return { ok: true }
    } catch (failure) {
      throw new Error(emailPrivacyMessage(failure))
    }
  })

/** Whether the caller's emails with this record are open to the workspace. */
export const getRecordEmailVisibility = createServerFn()
  .validator(z.object({ entityId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { recordEmailVisibilityProgram } =
      await import('../interactions/email-privacy')
    const { effectFn } = await import('./effect')
    return effectFn(recordEmailVisibilityProgram)(
      { id: user.id },
      data.entityId,
    )
  })

/** Opens or closes the caller's emails with this record to the workspace. */
export const setRecordEmailVisibility = createServerFn({ method: 'POST' })
  .validator(z.object({ entityId: z.uuid(), workspace: z.boolean() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { setRecordEmailVisibilityProgram, emailPrivacyMessage } =
      await import('../interactions/email-privacy')
    const { effectFn } = await import('./effect')
    try {
      await effectFn(setRecordEmailVisibilityProgram)({ id: user.id }, data)
      return { ok: true }
    } catch (failure) {
      throw new Error(emailPrivacyMessage(failure))
    }
  })
