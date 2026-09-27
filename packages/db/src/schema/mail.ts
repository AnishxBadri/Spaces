import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { integration } from './integrations'
import { credential } from './vault'

/**
 * The forwarding mailbox (SPA-56, arrival-1; decisions D30, D31, D49). An
 * address the fund forwards or BCCs mail to, owned by the operator and polled
 * over IMAP with an app password — no OAuth consent screen, no loader, no
 * registry, which is why this lane is core and not a plugin. Admin-only, one
 * row in practice; nothing here references `entity`, so it has no
 * `ENTITY_REFS` entry.
 *
 * `integration_id` is the provenance half. D1 made `source_ref` always name an
 * `integration` row, FK-enforced, so the core channel owns one such row
 * (`capability_id = 'core.mailbox'`) and every interaction, note and job run
 * this lane writes points at it.
 *
 * `last_uid` / `last_uid_validity` are the IMAP cursor. A UID is only
 * meaningful under the UIDVALIDITY it was read with: when the server changes
 * it (a folder recreated, a migrated mail store) every UID the cursor holds
 * names a different message or none, so the poll restarts from UID 1 and
 * leans on `interaction_message_id_unique` to skip what it already wrote.
 * Both are `bigint` because a UID is an unsigned 32-bit number and a Postgres
 * `integer` stops at 2^31.
 */

/**
 * `pending` until the first poll; `ok` after a clean one; `error` after a
 * refused login or an unreachable host, with the server's words in
 * `last_error` and `failure_count` driving the backoff.
 */
export const mailboxStatus = pgEnum('mailbox_status', [
  'pending',
  'ok',
  'error',
])

export type MailboxStatus = (typeof mailboxStatus.enumValues)[number]

export const mailbox = pgTable(
  'mailbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The core channel's integration row — what `source_ref` names. */
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integration.id),
    /** The address people forward to; also the IMAP login. */
    address: text('address').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(993),
    useTls: boolean('use_tls').notNull().default(true),
    folder: text('folder').notNull().default('INBOX'),
    /** The app password, `kind: 'mailbox'`; write-only from the UI. */
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => credential.id),
    cadenceMinutes: integer('cadence_minutes').notNull().default(5),
    lastUid: bigint('last_uid', { mode: 'number' }).notNull().default(0),
    lastUidValidity: bigint('last_uid_validity', { mode: 'number' }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    status: mailboxStatus('status').notNull().default('pending'),
    lastError: text('last_error'),
    /** Consecutive failed polls; zero after any clean one. */
    failureCount: integer('failure_count').notNull().default(0),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('mailbox_address_unique').on(t.address),
    // A cadence is a cron step inside the hour (`*/n * * * *`), so it lives
    // between one minute and sixty.
    check('mailbox_cadence_range', sql`${t.cadenceMinutes} between 1 and 60`),
  ],
)
