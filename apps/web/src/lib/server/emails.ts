import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
  draftAttachmentsSchema,
  draftRecipientsSchema,
} from '@spaces/core/json'
import { requireUser } from './shared'

export type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
} from '../interactions/email-read'
export type { EmailPrivacy } from '../interactions/email-privacy'
export type {
  DraftDocument,
  DraftFields,
  DraftRow,
  EmailDraft,
  RecipientMatch,
  ReplyOpening,
} from '../interactions/email-drafts'
export type { DraftRecipient, EmailDraftMode } from '@spaces/db/schema/drafts'
export type { VariableReview } from '../interactions/email-variables'
export type { EmailSender, Sent } from '../interactions/email-send'

/**
 * The email window's read and its privacy writes.
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

/**
 * Drafts: author-private, so every fn reads the caller and nothing
 * else. Programs are imported inside the handlers, as above.
 */
export const listEmailDrafts = createServerFn().handler(async () => {
  const user = await requireUser()
  const { listDraftsProgram } = await import('../interactions/email-drafts')
  const { effectFn } = await import('./effect')
  return effectFn(listDraftsProgram)({ id: user.id })
})

/** The account menu's count. */
export const countEmailDrafts = createServerFn().handler(async () => {
  const user = await requireUser()
  const { countDraftsProgram } = await import('../interactions/email-drafts')
  const { effectFn } = await import('./effect')
  return effectFn(countDraftsProgram)({ id: user.id })
})

export const getEmailDraft = createServerFn()
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { getDraftProgram, draftMessage } =
      await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(getDraftProgram)({ id: user.id }, data.id)
    } catch (failure) {
      throw new Error(draftMessage(failure))
    }
  })

/** The autosave: one upsert by the id the composer minted. */
export const saveEmailDraft = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.uuid(),
      mode: z.enum(['new', 'reply', 'reply_all', 'forward']),
      inReplyToId: z.uuid().nullable(),
      to: draftRecipientsSchema,
      cc: draftRecipientsSchema,
      bcc: draftRecipientsSchema,
      subject: z.string().max(998),
      bodyMd: z.string().max(200_000),
      attachments: draftAttachmentsSchema,
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { saveDraftProgram, draftMessage } =
      await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(saveDraftProgram)({ id: user.id }, data)
    } catch (failure) {
      throw new Error(draftMessage(failure))
    }
  })

/** Trash. */
export const deleteEmailDraft = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { deleteDraftProgram } = await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    await effectFn(deleteDraftProgram)({ id: user.id }, data.id)
    return { ok: true }
  })

/** Reply, reply all or forward from the email window. */
export const openEmailReply = createServerFn()
  .validator(z.object({ parentId: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { openReplyProgram, draftMessage } =
      await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(openReplyProgram)({ id: user.id }, data.parentId)
    } catch (failure) {
      throw new Error(draftMessage(failure))
    }
  })

/** The recipient chips' search: people by name or email alias. */
export const searchEmailRecipients = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { searchRecipientsProgram } =
      await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    return effectFn(searchRecipientsProgram)(data.q)
  })

/** Review: every variable the draft uses, resolved per recipient. */
export const reviewEmailVariables = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      to: draftRecipientsSchema,
      cc: draftRecipientsSchema,
      bcc: draftRecipientsSchema,
      subject: z.string().max(998),
      bodyMd: z.string().max(200_000),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { reviewVariablesProgram, variableMessage } =
      await import('../interactions/email-variables')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(reviewVariablesProgram)(data)
    } catch (failure) {
      throw new Error(variableMessage(failure))
    }
  })

/** Whether the composer may send: the viewer's Gmail, or the account to reconnect. */
export const getEmailSender = createServerFn()
  .validator(z.object({ parentId: z.uuid().nullable().default(null) }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { emailSenderProgram } = await import('../interactions/email-send')
    const { effectFn } = await import('./effect')
    return effectFn(emailSenderProgram)({ id: user.id }, data.parentId)
  })

/**
 * Send: the draft through the Gmail plugin, awaited. Review's fills come
 * with it; the server resolves every variable again.
 */
export const sendEmailDraft = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      draftId: z.uuid(),
      fills: z
        .record(
          z.string().max(320),
          z.record(z.string().max(200), z.string().max(2000)),
        )
        .default({}),
      accepted: z.array(z.string().max(320)).max(500).default([]),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { sendDraftLive, sendMessage } =
      await import('../interactions/email-send')
    const { effectFn } = await import('./effect')
    try {
      return await effectFn(sendDraftLive)({ id: user.id }, data)
    } catch (failure) {
      throw new Error(sendMessage(failure))
    }
  })
