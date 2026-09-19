import { and, eq, isNull } from 'drizzle-orm'
import { db } from '#/db'
import { credential } from '#/db/schema'
import type { CredentialMeta } from '#/db/schema/vault'
import { decryptSecret, encryptSecret, redact } from './crypto'

export { redact }

type CredentialInput = {
  scope: 'workspace' | 'user'
  userId?: string
  provider: string
  kind: 'llm' | 'enrichment' | 'search'
  secret: string
  meta?: CredentialMeta
  createdBy: string
}

function aadFor(scope: string, provider: string): string {
  return `${scope}:${provider}`
}

export async function storeCredential(input: CredentialInput) {
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
