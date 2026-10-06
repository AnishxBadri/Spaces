import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  jsonb,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { bytea } from './helpers'
import type { Json } from '../json'

/**
 * BYOK credential vault. One framework, all providers — LLM keys are just
 * one provider class. Envelope encryption AES-256-GCM, AAD = scope:provider,
 * master key from MASTER_KEY env (auto-generated to ./data/secret.key on
 * first boot). Write-only in UI, redacted in logs, decrypted only in worker.
 */

export const credentialScope = pgEnum('credential_scope', ['workspace', 'user'])
/**
 * What class of secret a row holds.
 * - `embedding` — embedding providers are not chat models: the pinned
 *   dimension makes them non-interchangeable (spec-ai-substrate §9).
 * - `oauth_client` — an OAuth app's client id/secret per provider, registered
 *   once by the operator (spec-plugin-sdk §12).
 * - `webhook` — a webhook signing secret per integration.
 * - `mailbox` — the forwarding mailbox's IMAP app password.
 *
 * Widening is free for stored ciphertext: the AAD is `scope:provider`, so
 * `kind` is not an encryption input and no existing row is re-encrypted.
 */
export const credentialKind = pgEnum('credential_kind', [
  'llm',
  'embedding',
  'enrichment',
  'search',
  'oauth_client',
  'webhook',
  'mailbox',
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
    // One credential per (scope, provider, kind, user): a user row per user,
    // and one workspace row per provider and kind — so a Gemini `llm` key and
    // a Google `oauth_client` both live on provider `google`. NULLS NOT
    // DISTINCT is what makes the workspace row's null user_id collide — and
    // what `storeCredential`'s ON CONFLICT targets for both scopes.
    unique('credential_user_unique')
      .on(t.scope, t.provider, t.kind, t.userId)
      .nullsNotDistinct(),
  ],
)

/**
 * OAuth grants for data ingestion (Gmail/Calendar/Drive/Box) — NEVER
 * conflated with auth sessions. "Login with Google" ≠ "sync my Gmail":
 * different scopes, consent, lifetime.
 */
export const connectionStatus = pgEnum('connection_status', [
  'active',
  'error',
  'revoked',
])

/**
 * One grant per user, provider, product (D66) and provider account.
 * - `tokens_enc` is one encrypted JSON bundle (access, refresh, type), AAD
 *   `connection:<user_id>:<provider>` — `encryptBundle`, never the
 *   credential AAD.
 * - `scopes` holds registry `value`s the provider granted, never the ones
 *   asked for.
 */
export const accountConnection = pgTable(
  'account_connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    provider: text('provider').notNull(),
    /** `drive` · `calendar` · `gmail` under google, `box` under box. */
    product: text('product').notNull(),
    externalEmail: text('external_email').notNull(),
    /** The provider's own account id: Google `sub`, Box user `id`. */
    externalAccountId: text('external_account_id'),
    tokensEnc: bytea('tokens_enc').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    /** When the access token lapses. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** When the refresh token lapses, when the provider says (Box). */
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
    }),
    status: connectionStatus('status').notNull().default('active'),
    /** The provider's reason when `status` is `error`. */
    errorReason: text('error_reason'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The callback's upsert target.
    uniqueIndex('account_connection_unique').on(
      t.userId,
      t.provider,
      t.product,
      t.externalEmail,
    ),
  ],
)
