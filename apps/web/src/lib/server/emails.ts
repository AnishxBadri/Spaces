import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { z } from 'zod'
import {
  draftAttachmentsSchema,
  draftRecipientsSchema,
} from '@spaces/core/json'
import { requireUser } from './shared'
import { input } from './input'

export type {
  EmailAttachment,
  EmailBody,
  EmailDetail,
  EmailParticipant,
  EmailThreadLine,
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
export type {
  VariableOption,
  VariableReview,
} from '../interactions/email-variables'
export type { EmailSender, Sent } from '../interactions/email-send'

const uuid = Schema.String.check(Schema.isUUID())

/** A uuid the caller may leave out; absent reads as null. */
const uuidOrNull = Schema.NullOr(uuid).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
)

/**
 * The email window's read and its privacy writes.
 * The programs are imported inside the handlers so their sanitizer and
 * database code never reach the client bundle.
 */
export const getEmail = createServerFn()
  .validator(input(Schema.Struct({ id: uuid, recordId: uuidOrNull })))
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
    input(
      Schema.Struct({
        interactionId: uuid,
        userIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(
          Schema.isMaxLength(200),
        ),
        record: Schema.NullOr(
          Schema.Struct({ id: uuid, workspace: Schema.Boolean }),
        ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
      }),
    ),
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
  .validator(input(Schema.Struct({ entityId: uuid })))
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
  .validator(
    input(Schema.Struct({ entityId: uuid, workspace: Schema.Boolean })),
  )
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

/** The sidebar's Drafts count. */
export const countEmailDrafts = createServerFn().handler(async () => {
  const user = await requireUser()
  const { countDraftsProgram } = await import('../interactions/email-drafts')
  const { effectFn } = await import('./effect')
  return effectFn(countDraftsProgram)({ id: user.id })
})

export const getEmailDraft = createServerFn()
  .validator(input(Schema.Struct({ id: uuid })))
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
  .validator(input(Schema.Struct({ id: uuid })))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { deleteDraftProgram } = await import('../interactions/email-drafts')
    const { effectFn } = await import('./effect')
    await effectFn(deleteDraftProgram)({ id: user.id }, data.id)
    return { ok: true }
  })

/** Reply, reply all or forward from the email window. */
export const openEmailReply = createServerFn()
  .validator(input(Schema.Struct({ parentId: uuid })))
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
  .validator(
    input(Schema.Struct({ q: Schema.String.check(Schema.isMaxLength(200)) })),
  )
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

/** The Variable picker's paths: the shared grammar's families and the person's attributes. */
export const listEmailVariables = createServerFn().handler(async () => {
  await requireUser()
  const { variableOptionsProgram } =
    await import('../interactions/email-variables')
  const { effectFn } = await import('./effect')
  return effectFn(variableOptionsProgram)()
})

/** Whether the composer may send: the viewer's Gmail, or the account to reconnect. */
export const getEmailSender = createServerFn()
  .validator(input(Schema.Struct({ parentId: uuidOrNull })))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const { emailSenderProgram } = await import('../interactions/email-send')
    const { effectFn } = await import('./effect')
    return effectFn(emailSenderProgram)({ id: user.id }, data.parentId)
  })

/**
 * Every key of a record at most `max` characters. A key schema cannot say
 * it: a record drops a key its key schema refuses rather than failing.
 */
const keysAtMost = (max: number) =>
  Schema.makeFilter(
    (o: { readonly [k: string]: unknown }) =>
      Object.keys(o).every((k) => k.length <= max) ||
      `Expected keys of at most ${max} characters`,
  )

/**
 * Send: the draft through the Gmail plugin, awaited. Review's fills come
 * with it; the server resolves every variable again.
 */
export const sendEmailDraft = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        draftId: uuid,
        fills: Schema.Record(
          Schema.String,
          Schema.Record(
            Schema.String,
            Schema.String.check(Schema.isMaxLength(2000)),
          ).check(keysAtMost(200)),
        )
          .check(keysAtMost(320))
          .pipe(Schema.withDecodingDefault(Effect.succeed({}))),
        accepted: Schema.Array(Schema.String.check(Schema.isMaxLength(320)))
          .check(Schema.isMaxLength(500))
          .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
      }),
    ),
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
