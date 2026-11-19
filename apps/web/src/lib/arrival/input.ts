import { Schema, SchemaTransformation } from 'effect'

/**
 * Settings → Arrival's inputs. Client-safe on purpose: the mailbox server
 * fns validate with these and are re-exported by the client-imported barrel,
 * so nothing here may import the vault, the database or imapflow.
 */

/** An address as the form takes it: trimmed, lower-cased, then checked. */
const address = Schema.String.pipe(
  Schema.decode(
    SchemaTransformation.trim().compose(SchemaTransformation.toLowerCase()),
  ),
).check(
  Schema.isPattern(
    /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/,
    { expected: 'an email address' },
  ),
  Schema.isMaxLength(320),
)

/** The mailbox's connection, as the section edits it. */
export const mailboxFields = Schema.Struct({
  address,
  host: Schema.Trim.check(
    Schema.isMinLength(1, { message: 'Host is required' }),
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9.-]+$/, {
      message: 'A host name, like imap.fastmail.com',
    }),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  useTls: Schema.Boolean,
  folder: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  cadenceMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 60 }),
  ),
})

/**
 * A save: the fields plus, optionally, a new app password. Omitted keeps the
 * stored one — the password is write-only and the section never has it to
 * send back — and the first save must carry one.
 */
export const mailboxInput = Schema.Struct({
  ...mailboxFields.fields,
  password: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ),
})

export type MailboxInput = typeof mailboxInput.Type

export const MAILBOX_DEFAULTS = {
  port: 993,
  useTls: true,
  folder: 'INBOX',
  cadenceMinutes: 5,
} as const
