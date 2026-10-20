import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { interaction } from './interactions'

/**
 * Email drafts (D67): author-private, local only — never synced to the
 * mailbox's drafts. Every read filters on `email_draft.user_id`.
 * - Reply modes carry `in_reply_to_id`, from which send takes `In-Reply-To`
 *   and `References`; a parent that goes away leaves a plain draft.
 * - Recipients are addresses, not edges: a draft links to no record until
 *   it is sent, and a Bcc is never linked at all.
 */

export const emailDraftMode = pgEnum('email_draft_mode', [
  'new',
  'reply',
  'reply_all',
  'forward',
])

export type EmailDraftMode = (typeof emailDraftMode.enumValues)[number]

/** One recipient chip: the address chosen, and the person it is an alias of. */
export type DraftRecipient = {
  email: string
  /** The person record whose alias `email` is; absent for a new address. */
  entityId?: string
  name?: string
}

/** A document the draft carries; read through `canReadDocumentSql`. */
export type DraftAttachment = { documentId: string }

export const emailDraft = pgTable(
  'email_draft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mode: emailDraftMode('mode').notNull().default('new'),
    inReplyToId: uuid('in_reply_to_id').references(() => interaction.id, {
      onDelete: 'set null',
    }),
    to: jsonb('to').$type<Array<DraftRecipient>>().notNull().default([]),
    cc: jsonb('cc').$type<Array<DraftRecipient>>().notNull().default([]),
    bcc: jsonb('bcc').$type<Array<DraftRecipient>>().notNull().default([]),
    subject: text('subject').notNull().default(''),
    bodyMd: text('body_md').notNull().default(''),
    attachments: jsonb('attachments')
      .$type<Array<DraftAttachment>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('email_draft_user_idx').on(t.userId, t.updatedAt),
    index('email_draft_reply_idx').on(t.inReplyToId),
  ],
)
