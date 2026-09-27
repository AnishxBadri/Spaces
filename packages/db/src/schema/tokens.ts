import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * Per-user API tokens — the MCP server's credential (SPA-23,
 * `docs/spec-ai-substrate.md` §5).
 *
 * Decided by the owner 2026-09-27 (SPA-23, hitl resolved): per-user bearer
 * tokens in this table — no OAuth, and not better-auth's `mcp` or `bearer`
 * plugin. Per-user because canRead is per user: a teammate's assistant sees
 * what that teammate sees. A table because the required-env set is frozen
 * at DATABASE_URL and APP_URL, so no external identity provider may appear.
 *
 * The plaintext never lands here: `token_hash` is the sha256 of it, and
 * `prefix` is the first few characters, kept so the settings ledger can say
 * which token a row is. Revoke sets `revoked_at`; nothing deletes a row.
 * `user_id` references the better-auth `user` table, not an entity, so
 * `ENTITY_REFS` has nothing to say about it.
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
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_token_user_idx').on(t.userId)],
)
