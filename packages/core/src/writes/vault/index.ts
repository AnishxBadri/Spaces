import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { credentialKind, credentialScope } from '@spaces/db/schema/vault'
import type { CredentialMeta } from '@spaces/db/schema/vault'
import { jsonValue } from '../../json'
import { decryptSecret, encryptSecret, redact } from './crypto'

export { redact }

/**
 * The credential kinds, read off the column rather than retyped, so widening
 * the enum widens this boundary in the same edit and cannot drift from it.
 */
export const CREDENTIAL_KINDS = credentialKind.enumValues

/**
 * The vault's write boundary. A kind Postgres would reject is rejected here
 * first, with a field-named Zod error instead of a 22P02 from the driver —
 * the database is the backstop, not the validator.
 */
export const credentialInput = z
  .object({
    scope: z.enum(credentialScope.enumValues),
    userId: z.string().optional(),
    provider: z.string().min(1),
    kind: z.enum(CREDENTIAL_KINDS),
    secret: z.string().max(4000),
    /**
     * A provider that authenticates nobody (a local Ollama). Its row
     * still carries `secret_enc` — the column stays not-null — holding the
     * encryption of the empty string. Saying so is the only way to store an
     * empty secret: without the flag an empty one is refused, so a blank
     * paste into a keyed provider's field cannot pass for a key.
     */
    keyless: z.literal(true).optional(),
    meta: z.record(z.string(), jsonValue).optional(),
    createdBy: z.string().min(1),
  })
  .superRefine((input, ctx) => {
    if (input.keyless && input.secret !== '')
      ctx.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'A keyless credential stores no secret',
      })
    if (!input.keyless && input.secret === '')
      ctx.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Secret is required',
      })
  })

export type CredentialInput = z.infer<typeof credentialInput>

/** What a row holds. A lookup names it: one provider may hold several kinds. */
export type CredentialKind = CredentialInput['kind']

function aadFor(scope: string, provider: string): string {
  return `${scope}:${provider}`
}

function workspaceRow(provider: string, kind: CredentialKind) {
  return and(
    eq(credential.scope, 'workspace'),
    eq(credential.provider, provider),
    eq(credential.kind, kind),
    isNull(credential.userId),
  )
}

/**
 * Writes (or replaces) one credential: one upsert on `credential_user_unique`
 * for both scopes.
 * - The constraint is NULLS NOT DISTINCT, so a workspace row's null
 *   `user_id` conflicts like a user's id does, and two first-time saves
 *   racing each other leave one row holding the later key.
 * - `kind` is in the target: a Google `oauth_client` never replaces a
 *   Gemini `llm` key on provider `google`.
 */
export async function storeCredential(rawInput: CredentialInput) {
  const input = credentialInput.parse(rawInput)
  const secretEnc = encryptSecret(
    input.secret,
    aadFor(input.scope, input.provider),
  )
  const meta = input.meta ?? {}

  const [row] = await db
    .insert(credential)
    .values({
      scope: input.scope,
      userId: input.scope === 'workspace' ? null : input.userId,
      provider: input.provider,
      kind: input.kind,
      secretEnc,
      meta,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [
        credential.scope,
        credential.provider,
        credential.kind,
        credential.userId,
      ],
      set: { secretEnc, meta, status: 'active' },
    })
    .returning({ id: credential.id })
  return { id: row.id, display: redact(input.secret) }
}

/**
 * A resolved credential: the decrypted secret and the row's non-secret
 * `meta` (base URL, extra headers, last test), which an adapter needs as much
 * as the key — a gateway passthrough is a `baseURL` plus a header.
 * `resolveSecret` is this minus the meta.
 */
export type ResolvedCredential = {
  id: string
  scope: 'workspace' | 'user'
  secret: string
  meta: CredentialMeta
}

/**
 * Resolution order: user key → workspace key → null.
 * Null means the feature is hidden, not broken.
 */
export async function resolveCredential(
  provider: string,
  kind: CredentialKind,
  userId?: string,
): Promise<ResolvedCredential | null> {
  if (userId) {
    const userRow = (
      await db
        .select()
        .from(credential)
        .where(
          and(
            eq(credential.scope, 'user'),
            eq(credential.provider, provider),
            eq(credential.kind, kind),
            eq(credential.userId, userId),
            eq(credential.status, 'active'),
          ),
        )
        .limit(1)
    ).at(0)
    if (userRow) {
      touch(userRow.id)
      return {
        id: userRow.id,
        scope: 'user',
        secret: decryptSecret(userRow.secretEnc, aadFor('user', provider)),
        meta: userRow.meta,
      }
    }
  }

  const wsRow = (
    await db
      .select()
      .from(credential)
      .where(and(workspaceRow(provider, kind), eq(credential.status, 'active')))
      .limit(1)
  ).at(0)
  if (wsRow) {
    touch(wsRow.id)
    return {
      id: wsRow.id,
      scope: 'workspace',
      secret: decryptSecret(wsRow.secretEnc, aadFor('workspace', provider)),
      meta: wsRow.meta,
    }
  }

  return null
}

/** The secret alone — `resolveCredential` for callers that need no meta. */
export async function resolveSecret(
  provider: string,
  kind: CredentialKind,
  userId?: string,
): Promise<string | null> {
  return (await resolveCredential(provider, kind, userId))?.secret ?? null
}

/**
 * One row's secret by id, for a caller that holds a foreign key to it rather
 * than a provider name — the forwarding mailbox's `credential_id`.
 * Null when the row is gone or marked invalid. Decrypted here, in the vault,
 * with the same `scope:provider` AAD every other read uses.
 */
export async function resolveSecretById(id: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(credential)
      .where(and(eq(credential.id, id), eq(credential.status, 'active')))
      .limit(1)
  ).at(0)
  if (!row) return null
  touch(row.id)
  return decryptSecret(row.secretEnc, aadFor(row.scope, row.provider))
}

/**
 * The workspace row for a provider and kind, without its secret — what a
 * settings ledger draws. Nothing is decrypted and nothing is touched.
 */
export async function readWorkspaceCredential(
  provider: string,
  kind: CredentialKind,
) {
  return (
    await db
      .select({
        id: credential.id,
        kind: credential.kind,
        meta: credential.meta,
        status: credential.status,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
      })
      .from(credential)
      .where(workspaceRow(provider, kind))
      .limit(1)
  ).at(0)
}

/**
 * Merges keys into a row's `meta` without touching its ciphertext — a test
 * result, or a base URL changed while the key stays. jsonb `||` is shallow:
 * a key given here replaces the stored one whole.
 */
export async function mergeCredentialMeta(
  id: string,
  patch: CredentialMeta,
): Promise<void> {
  await db
    .update(credential)
    .set({ meta: sql`${credential.meta} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(credential.id, id))
}

function touch(id: string) {
  // Fire-and-forget usage timestamp; failures are irrelevant.
  db.update(credential)
    .set({ lastUsedAt: new Date() })
    .where(eq(credential.id, id))
    .catch(() => {})
}
