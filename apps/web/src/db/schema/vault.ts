import {
  customType,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import type { Json } from '#/lib/json'

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/**
 * BYOK credential vault. One framework, all providers — LLM keys are just
 * one provider class. Envelope encryption AES-256-GCM, AAD = scope:provider,
 * master key from MASTER_KEY env (auto-generated to ./data/secret.key on
 * first boot). Write-only in UI, redacted in logs, decrypted only in worker.
 */

export const credentialScope = pgEnum('credential_scope', ['workspace', 'user'])
export const credentialKind = pgEnum('credential_kind', [
  'llm',
  'enrichment',
  'search',
])
/** Non-secret provider config: base URL for Ollama, model mapping, etc. */
export type CredentialMeta = { [k: string]: Json }

export const credentialStatus = pgEnum('credential_status', [
  'active',
  'invalid',
])

export const credential = pgTable(
  'credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: credentialScope('scope').notNull().default('workspace'),
    // Resolution order: user key → workspace key → none (feature hidden).
    userId: text('user_id').references(() => user.id),
    provider: text('provider').notNull(),
    kind: credentialKind('kind').notNull(),
    secretEnc: bytea('secret_enc').notNull(),
    // Non-secret config: base URL for Ollama, model mapping, etc.
    meta: jsonb('meta').$type<CredentialMeta>().notNull().default({}),
    status: credentialStatus('status').notNull().default('active'),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    // One credential per (scope, provider) per user; workspace rows have
    // null user_id and Postgres treats nulls as distinct, so workspace
    // uniqueness is (scope, provider) via the partial index below.
    uniqueIndex('credential_user_unique').on(t.scope, t.provider, t.userId),
  ],
)

/**
 * OAuth grants for data ingestion (Gmail/Calendar) — NEVER conflated with
 * auth sessions. "Login with Google" ≠ "sync my Gmail": different scopes,
 * consent, lifetime. Post-MVP, table exists from migration one.
 */
export const connectionStatus = pgEnum('connection_status', [
  'active',
  'error',
  'revoked',
])

export const accountConnection = pgTable(
  'account_connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    provider: text('provider').notNull(),
    externalEmail: text('external_email').notNull(),
    tokensEnc: bytea('tokens_enc').notNull(),
    status: connectionStatus('status').notNull().default('active'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('account_connection_unique').on(
      t.userId,
      t.provider,
      t.externalEmail,
    ),
  ],
)
