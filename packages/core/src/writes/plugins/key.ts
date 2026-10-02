import { Effect, Schema } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import { storeCredential } from '../vault/index'
import type { CredentialInput } from '../vault/index'

/** The key could not be stored or the row could not be written. */
export class KeyIntegrationFailed extends Schema.TaggedError<KeyIntegrationFailed>()(
  'KeyIntegrationFailed',
  { reason: Schema.String },
) {}

export type KeyIntegrationInput = {
  /** The plugin's manifest id — the row's `capability_id`. */
  readonly capabilityId: string
  readonly version: string
  readonly kind: CredentialInput['kind']
  readonly secret: string
  /** The user the credential is recorded as created by. */
  readonly createdBy: string
}

/**
 * Keys a plugin by hand: the secret becomes the workspace credential for
 * `capabilityId` (through `storeCredential`, so the vault encrypts it), and
 * the plugin's `integration` row points at it, enabled.
 * - Idempotent: a second run replaces the secret in place and updates the
 *   same row. An advisory lock keeps two concurrent runs from both inserting.
 * - `status` is left to the loader, which marks the row when it next boots.
 */
export const keyIntegration = Effect.fn('keyIntegration')(function* (
  input: KeyIntegrationInput,
) {
  const failed = (step: string) => (cause: unknown) =>
    new KeyIntegrationFailed({
      reason: `${step}: ${cause instanceof Error ? cause.message : String(cause)}`,
    })

  const stored = yield* Effect.tryPromise({
    try: () =>
      storeCredential({
        scope: 'workspace',
        provider: input.capabilityId,
        kind: input.kind,
        secret: input.secret,
        createdBy: input.createdBy,
      }),
    catch: failed('storing the credential'),
  })

  const row = yield* Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`integration:${input.capabilityId}`}))`,
        )
        const existing = (
          await tx
            .select({ id: integration.id })
            .from(integration)
            .where(eq(integration.capabilityId, input.capabilityId))
            .orderBy(integration.createdAt)
            .limit(1)
        ).at(0)
        const values = {
          version: input.version,
          enabled: true,
          credentialId: stored.id,
        }
        if (existing) {
          await tx
            .update(integration)
            .set(values)
            .where(eq(integration.id, existing.id))
          return { id: existing.id, created: false }
        }
        const inserted = (
          await tx
            .insert(integration)
            .values({ capabilityId: input.capabilityId, ...values })
            .returning({ id: integration.id })
        ).at(0)
        if (!inserted) throw new Error('integration insert returned no row')
        return { id: inserted.id, created: true }
      }),
    catch: failed('writing the integration row'),
  })

  return {
    integrationId: row.id,
    created: row.created,
    credentialId: stored.id,
    display: stored.display,
  }
})
