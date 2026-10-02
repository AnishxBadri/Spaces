import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * Per-user API tokens — the one credential store for the MCP server and the
 * `/api/v1` door. Per-user because canRead is per user; not OAuth, not a
 * better-auth plugin. (CONTEXT.md "API tokens")
 * - The plaintext never lands here: `token_hash` is its sha256; `prefix` is
 *   kept so the settings ledger can say which token a row is.
 * - Revoke sets `revoked_at`; nothing deletes a row.
 * - `scopes` is a subset of the pinned scope list. `'{}'` still opens MCP,
 *   and at the door only the procedures that need no scope (`session.me`).
 */
export const apiToken = pgTable(
  'api_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    prefix: text('prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_token_user_idx').on(t.userId)],
)
