import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Identity, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { AliasClaim, AliasResult, IdentityClaim } from '@spaces/sdk'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import { dispatchDomainEvent } from '../events/dispatch'
import {
  RESOLVE_NEEDS_NAME_OR_KEY,
  normalizeKeys,
  resolveEntity,
} from '../entities/resolve'
import { addIdentityValue } from '../attributes/identity-values'
import { canonicalId } from '../entities/sweep'
import type { ResolveSource } from '../entities/resolve'
import type { BoundIntegration } from './binding'

/**
 * IdentityLive: the Identity port over `resolveEntity` and `addIdentityValue`,
 * with provenance `{ class: 'integration', ref: <bound row id> }` built **by
 * the port** from its row — the claim carries no source, so nothing a job
 * passes can change who wrote the entity, its aliases or its birth values.
 * - `resolve` attaches or creates, then claims **every** key on that entity
 *   through `setValues`: a key another entity holds stays `attached` here
 *   and becomes a `duplicate_candidate`, never an error or a second entity.
 *   A LinkedIn URL identifies neither kind and is not claimed.
 * - A birth writes one `<kind>.created` activity row (integration in `meta`)
 *   and sends `reembed` and `entity.created` through `Enqueue`.
 */

/** What an integration-written activity row carries in `meta`. */
export const integrationMeta = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
) => ({
  actorType: 'integration',
  integrationId: row.id,
  capabilityId: row.capabilityId,
})

const sourceOf = (row: Pick<BoundIntegration, 'id'>): ResolveSource => ({
  class: 'integration',
  ref: row.id,
})

const failure = (what: string) => (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message === RESOLVE_NEEDS_NAME_OR_KEY
    ? new JobPermanent({ reason: `Identity.${what}: ${message}` })
    : new JobRetryable({ reason: `Identity.${what} failed: ${message}` })
}

export const IdentityLive = (
  row: Pick<BoundIntegration, 'id' | 'capabilityId'>,
): Layer.Layer<Identity, never, Enqueue> =>
  Layer.effect(
    Identity,
    Effect.gen(function* () {
      const context = yield* Effect.context<Enqueue>()
      const source = sourceOf(row)

      /** Claim each normalized key on `entityId`; a held key → candidate. */
      const claimAll = (
        entityId: string,
        claim: Pick<IdentityClaim, 'kind' | 'keys'>,
      ) =>
        Effect.forEach(normalizeKeys(claim), (key) =>
          Effect.tryPromise({
            try: () =>
              addIdentityValue({
                entityId,
                key: key.kind,
                value: key.value,
                actor: { type: 'integration', id: row.id },
                identitySource: source,
              }),
            catch: failure('claim'),
          }).pipe(Effect.map(({ outcome }) => ({ key: key.kind, outcome }))),
        )

      const resolve = (claim: IdentityClaim) =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise({
            try: () =>
              resolveEntity({
                kind: claim.kind,
                ...(claim.name === undefined ? {} : { name: claim.name }),
                keys: claim.keys,
                source,
              }),
            catch: failure('resolve'),
          })
          yield* enqueueEmbeds(result.reembed)
          if (result.action === 'created') {
            yield* Effect.tryPromise({
              try: () =>
                db.insert(activity).values({
                  actorId: null,
                  verb: `${claim.kind}.created`,
                  subjectEntityId: result.entityId,
                  meta: integrationMeta(row),
                }),
              catch: failure('resolve'),
            })
          }
          yield* claimAll(result.entityId, claim)
          yield* dispatchDomainEvent(result.emit)
          return { entityId: result.entityId, outcome: result.action }
        }).pipe(Effect.provide(context))

      const addAlias = (claim: AliasClaim) =>
        Effect.gen(function* () {
          // The record's own kind decides which keys it may take — a role
          // email never identifies a person — so it is read, not assumed.
          const target = yield* Effect.tryPromise({
            try: async () =>
              (
                await db
                  .select({ kind: entity.kind })
                  .from(entity)
                  .where(eq(entity.id, await canonicalId(claim.entityId)))
              ).at(0),
            catch: failure('addAlias'),
          })
          if (target?.kind !== 'company' && target?.kind !== 'person') {
            return yield* new JobPermanent({
              reason: `Identity.addAlias: ${claim.entityId} is not a company or a person`,
            })
          }
          const keys = yield* claimAll(claim.entityId, {
            kind: target.kind,
            keys: claim.keys,
          })
          const result: AliasResult = { keys }
          return result
        })

      return Identity.of({ resolve, addAlias })
    }),
  )
