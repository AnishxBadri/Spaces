import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { Identity, JobPermanent, JobRetryable } from '@spaces/sdk'
import type { AliasClaim, AliasResult, IdentityClaim } from '@spaces/sdk'
import type { Enqueue } from '../../queue/enqueue'
import { enqueueEmbeds } from '../ai/enqueue-embed'
import {
  RESOLVE_NEEDS_NAME_OR_KEY,
  addIdentityAlias,
  normalizeKeys,
  resolveEntity,
} from '../entities/resolve'
import { canonicalId } from '../entities/sweep'
import type { ResolveSource } from '../entities/resolve'
import type { BoundIntegration } from './binding'

/**
 * IdentityLive (sdk-7a): the Identity port over core's choke point,
 * `resolveEntity` and `addIdentityAlias`, with the provenance supplied **by
 * the port** — `{ class: 'integration', ref: <bound row id> }` — and never by
 * the plugin: the claim types carry no source field (D52), and this module
 * builds the source from the row it was given, so nothing a job passes can
 * change who wrote the entity, its aliases or its birth values.
 *
 * `resolve` attaches to the entity a key identifies, or creates one, exactly
 * as every other caller of the choke point does. It then claims **every**
 * key of the claim on that entity, which is what the frozen contract says
 * (`ResolveOutcome`): a key another entity already holds is still `attached`
 * to the one that matched, and the collision becomes a `duplicate_candidate`
 * for a human — never an error, never a second entity. Enrichment finds
 * your duplicates as a side effect.
 *
 * A birth writes one `activity` row (`<kind>.created`) with no `actor_id`
 * and the integration named in `meta`, which the record timeline reads; its
 * embeddable values (`reembed`) go out through core's `Enqueue` service,
 * which the process running the port provides.
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
            try: () => addIdentityAlias(entityId, key.kind, key.value, source),
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
