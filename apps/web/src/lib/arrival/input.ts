import { z } from 'zod'

/**
 * Settings → Arrival's inputs (SPA-56). Client-safe on purpose: the server
 * fns in `lib/server/mailbox.ts` validate with these and that module is
 * re-exported by the client-imported barrel, so nothing here may import the
 * vault, the database or imapflow.
 */

/** The mailbox's connection, as the section edits it. */
export const mailboxFields = z.object({
  address: z.string().trim().toLowerCase().email().max(320),
  host: z
    .string()
    .trim()
    .min(1, 'Host is required')
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/, 'A host name, like imap.fastmail.com'),
  port: z.number().int().min(1).max(65535),
  useTls: z.boolean(),
  folder: z.string().trim().min(1).max(255),
  cadenceMinutes: z.number().int().min(1).max(60),
})

/**
 * A save: the fields plus, optionally, a new app password. Omitted keeps the
 * stored one — the password is write-only and the section never has it to
 * send back — and the first save must carry one.
 */
export const mailboxInput = mailboxFields.extend({
  password: z.string().min(1).max(1000).optional(),
})

export type MailboxInput = z.infer<typeof mailboxInput>

/** Test connection: the same shape, so an unsaved form can be tried first. */
export const mailboxTestInput = mailboxInput

export const MAILBOX_DEFAULTS = {
  port: 993,
  useTls: true,
  folder: 'INBOX',
  cadenceMinutes: 5,
} as const
