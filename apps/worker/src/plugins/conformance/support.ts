import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { db } from '@spaces/db'
import { integration } from '@spaces/db/schema'
import type { IntegrationConfig } from '@spaces/db/schema/integrations'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'

/**
 * What the port conformance files share. Each file runs one contract over
 * an array of implementations — the live port on the test database and the
 * SDK's in-memory one — so a third implementation is one more entry.
 */

/** Core's lanes hand work back through `Enqueue`; conformance drops it. */
export const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** An enabled `integration` row the live ports bind to. */
export const insertRow = async (
  capabilityId = 'conformance',
  values: {
    readonly config?: IntegrationConfig
    readonly credentialId?: string
  } = {},
) => {
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true, ...values })
      .returning()
  ).at(0)
  if (!row) throw new Error('no integration row')
  return row
}

export const seedCompany = async (name: string, domain?: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      ...(domain === undefined ? {} : { keys: { domain } }),
      source: { class: 'manual' },
    })
  ).entityId

/** Runs `program` on `layer` to its Exit. */
export const exitOn = <TValue, TError, TServices, TLayerError>(
  layer: Layer.Layer<TServices, TLayerError>,
  program: Effect.Effect<TValue, TError, TServices>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)))

/** Runs `program` on `layer`; a failure throws. */
export const runOn = <TValue, TError, TServices, TLayerError>(
  layer: Layer.Layer<TServices, TLayerError>,
  program: Effect.Effect<TValue, TError, TServices>,
) => Effect.runPromise(program.pipe(Effect.provide(layer)))

/** The typed failure an Exit carries, or null for a success or a defect. */
export const failureOf = <TValue, TError>(
  exit: Exit.Exit<TValue, TError>,
): TError | null =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.findErrorOption(exit.cause))
    : null
