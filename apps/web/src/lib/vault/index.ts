import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { credentialKind, credentialScope } from '@spaces/db/schema/vault'
import type { CredentialMeta } from '@spaces/db/schema/vault'
import { jsonValue } from '#/lib/json'
import { decryptSecret, encryptSecret, redact } from './crypto'

export { redact }

/**
 * The six kinds, read off the column rather than retyped, so widening the
 * enum (SPA-112) widens this boundary in the same edit and cannot drift from
 * it. `llm` and (from SPA-29's AI settings on) the AI substrate write here;
 * `embedding`, `oauth_client` and `webhook` are claimed by the AI substrate,
 * `storage-1` and `sdk-23`.
 */
export const CREDENTIAL_KINDS = credentialKind.enumValues

/**
 * The vault's write boundary. A kind Postgres would reject is rejected here
 * first, with a field-named Zod error instead of a 22P02 from the driver —
 * the database is the backstop, not the validator (CONTEXT.md: Zod stays at
 * the boundaries, hand-written at write-path choke points).
 */
export const credentialInput = z
  .object({
    scope: z.enum(credentialScope.enumValues),
    userId: z.string().optional(),
    provider: z.string().min(1),
    kind: z.enum(CREDENTIAL_KINDS),
    secret: z.string().max(4000),
    /**
     * A provider that authenticates nobody (a local Ollama, SPA-39). Its row
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

function aadFor(scope: string, provider: string): string {
  return `${scope}:${provider}`
}

function workspaceRow(provider: string) {
  return and(
    eq(credential.scope, 'workspace'),
    eq(credential.provider, provider),
    isNull(credential.userId),
  )
}

/**
 * Writes (or replaces) one credential. A user row upserts on its unique
 * index; a workspace row cannot, because `credential_user_unique` covers
 * `(scope, provider, user_id)` and Postgres treats the workspace row's null
 * `user_id` as distinct from every other null — `ON CONFLICT` never fires, and
 * a second save would add a second row that resolution could pick instead of
 * the new one. So the workspace path locks its row and updates it in place.
 */
export async function storeCredential(rawInput: CredentialInput) {
  const input = credentialInput.parse(rawInput)
  const secretEnc = encryptSecret(
    input.secret,
    aadFor(input.scope, input.provider),
  )
  const meta = input.meta ?? {}

  if (input.scope === 'workspace') {
    const id = await db.transaction(async (tx) => {
      const existing = (
        await tx
          .select({ id: credential.id })
          .from(credential)
          .where(workspaceRow(input.provider))
          .limit(1)
          .for('update')
      ).at(0)
      if (existing) {
        await tx
          .update(credential)
          .set({ kind: input.kind, secretEnc, meta, status: 'active' })
          .where(eq(credential.id, existing.id))
        return existing.id
      }
      const [row] = await tx
        .insert(credential)
        .values({
          scope: 'workspace',
          userId: null,
          provider: input.provider,
          kind: input.kind,
          secretEnc,
          meta,
          createdBy: input.createdBy,
        })
        .returning({ id: credential.id })
      return row.id
    })
    return { id, display: redact(input.secret) }
  }

  const [row] = await db
    .insert(credential)
    .values({
      scope: input.scope,
      userId: input.userId,
      provider: input.provider,
      kind: input.kind,
      secretEnc,
      meta,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [credential.scope, credential.provider, credential.userId],
      set: { secretEnc, meta, status: 'active' },
    })
    .returning({ id: credential.id })
  return { id: row.id, display: redact(input.secret) }
}

/**
 * A resolved credential: the decrypted secret and the row's non-secret
 * `meta` (base URL, extra headers, last test), which an adapter needs as much
 * as the key — a gateway passthrough is a `baseURL` plus a header
 * (`docs/spec-ai-substrate.md` §9). `resolveSecret` is this minus the meta.
 */
export type ResolvedCredential = {
  id: string
  scope: 'workspace' | 'user'
  secret: string
  meta: CredentialMeta
}

/**
 * Resolution order per CONTEXT.md: user key → workspace key → null.
 * Null means the feature is hidden, not broken.
 */
export async function resolveCredential(
  provider: string,
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
      .where(and(workspaceRow(provider), eq(credential.status, 'active')))
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
  userId?: string,
): Promise<string | null> {
  return (await resolveCredential(provider, userId))?.secret ?? null
}

/**
 * The workspace row for a provider, without its secret — what a settings
 * ledger draws. Nothing is decrypted and nothing is touched.
 */
export async function readWorkspaceCredential(provider: string) {
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
      .where(workspaceRow(provider))
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
