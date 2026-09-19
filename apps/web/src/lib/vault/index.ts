import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { credential } from '@spaces/db/schema'
import { credentialKind, credentialScope } from '@spaces/db/schema/vault'
import { jsonValue } from '#/lib/json'
import { decryptSecret, encryptSecret, redact } from './crypto'

export { redact }

/**
 * The six kinds, read off the column rather than retyped, so widening the
 * enum (SPA-112) widens this boundary in the same edit and cannot drift from
 * it. `llm` is the only one written today; `embedding`, `oauth_client` and
 * `webhook` are claimed by the AI substrate, `storage-1` and `sdk-23`.
 */
export const CREDENTIAL_KINDS = credentialKind.enumValues

/**
 * The vault's write boundary. A kind Postgres would reject is rejected here
 * first, with a field-named Zod error instead of a 22P02 from the driver —
 * the database is the backstop, not the validator (CONTEXT.md: Zod stays at
 * the boundaries, hand-written at write-path choke points).
 */
export const credentialInput = z.object({
  scope: z.enum(credentialScope.enumValues),
  userId: z.string().optional(),
  provider: z.string().min(1),
  kind: z.enum(CREDENTIAL_KINDS),
  secret: z.string().min(1).max(4000),
  meta: z.record(z.string(), jsonValue).optional(),
  createdBy: z.string().min(1),
})

export type CredentialInput = z.infer<typeof credentialInput>

function aadFor(scope: string, provider: string): string {
  return `${scope}:${provider}`
}

export async function storeCredential(rawInput: CredentialInput) {
  const input = credentialInput.parse(rawInput)
  const secretEnc = encryptSecret(
    input.secret,
    aadFor(input.scope, input.provider),
  )
  const [row] = await db
    .insert(credential)
    .values({
      scope: input.scope,
      userId: input.scope === 'user' ? input.userId : null,
      provider: input.provider,
      kind: input.kind,
      secretEnc,
      meta: input.meta ?? {},
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [credential.scope, credential.provider, credential.userId],
      set: { secretEnc, meta: input.meta ?? {}, status: 'active' },
    })
    .returning({ id: credential.id })
  return { id: row.id, display: redact(input.secret) }
}

/**
 * Resolution order per CONTEXT.md: user key → workspace key → null.
 * Null means the feature is hidden, not broken.
 */
export async function resolveSecret(
  provider: string,
  userId?: string,
): Promise<string | null> {
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
      return decryptSecret(userRow.secretEnc, aadFor('user', provider))
    }
  }

  const wsRow = (
    await db
      .select()
      .from(credential)
      .where(
        and(
          eq(credential.scope, 'workspace'),
          eq(credential.provider, provider),
          isNull(credential.userId),
          eq(credential.status, 'active'),
        ),
      )
      .limit(1)
  ).at(0)
  if (wsRow) {
    touch(wsRow.id)
    return decryptSecret(wsRow.secretEnc, aadFor('workspace', provider))
  }

  return null
}

function touch(id: string) {
  // Fire-and-forget usage timestamp; failures are irrelevant.
  db.update(credential)
    .set({ lastUsedAt: new Date() })
    .where(eq(credential.id, id))
    .catch(() => {})
}
