import { Data, Effect, Layer } from 'effect'
import type { z } from 'zod'
import type { Manifest, PortName } from '@spaces/sdk'
import type { Enqueue } from '@spaces/core/queue/enqueue'
import { AmbientPortsLive } from '@spaces/core/writes/ports/ambient'
import type { BoundIntegration } from '@spaces/core/writes/ports/binding'
import type { ConfigInvalid } from '@spaces/core/writes/ports/config'
import { ContentLive } from '@spaces/core/writes/ports/content'
import { FactsLive } from '@spaces/core/writes/ports/facts'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { IdentityLive } from '@spaces/core/writes/ports/identity'
import { JudgmentLive } from '@spaces/core/writes/ports/judgment'
import type { LogSink } from '@spaces/core/writes/ports/log'
import { ReadLive } from '@spaces/core/writes/ports/read'
import { ReceiptsLive } from '@spaces/core/writes/ports/receipts'

/**
 * The grant: the Layer one (integration, job) runs on, built from exactly
 * the ports the job's `uses` names and bound to the row (D51).
 *
 * - There is no port table: `uses` is the grant. The host picks the declared
 *   tags out of what this builds, so an ambient port the job did not name
 *   never reaches it.
 * - `Enqueue` is provided to the lanes that hand work back and is never one
 *   of the job's services.
 */

/** Ports this host has no live Layer for; a job declaring one degrades its plugin. */
export const UNPROVIDED_PORTS: ReadonlyArray<PortName> = ['Ai', 'PluginDb']

/** The first (job, port) in the manifest this host cannot provide. */
export const unprovidedPort = (
  manifest: Manifest,
): { readonly job: string; readonly port: PortName } | null => {
  for (const [job, declared] of Object.entries(manifest.jobs)) {
    const port = declared.uses.find((p) => UNPROVIDED_PORTS.includes(p))
    if (port !== undefined) return { job, port }
  }
  return null
}

/** A port the grant was asked for and has no Layer for. */
export class PortUnprovided extends Data.TaggedError('PortUnprovided')<{
  readonly reason: string
}> {}

const AMBIENT: ReadonlyArray<PortName> = ['Config', 'Secrets', 'Log', 'Http']

/** What every grant shares, from the host and the bundle. */
export type GrantOptions = {
  /** The bundle's `manifest.settings` zod schema. */
  readonly settings: z.ZodType
  /** `manifest.http.rateLimit.rpm`. */
  readonly rpm?: number
  /** Built inside the job's scope, so its pool closes on release. */
  readonly enqueue: Layer.Layer<Enqueue>
  readonly fetch?: FetchLike
  readonly sink?: LogSink
}

const mergeList = <TError, TIn>(
  layers: ReadonlyArray<Layer.Layer<never, TError, TIn>>,
): Layer.Layer<never, TError, TIn> =>
  layers.reduce<Layer.Layer<never, TError, TIn>>(
    (merged, layer) => Layer.merge(merged, layer),
    Layer.empty,
  )

/**
 * The Layer for one job. Its static output is `never` on purpose: which
 * services it holds is decided by `uses` at runtime, and the job's `R` did
 * not survive the bundle boundary to be checked against it.
 */
export const grantLayer = (
  row: BoundIntegration,
  uses: ReadonlyArray<PortName>,
  options: GrantOptions,
): Layer.Layer<never, ConfigInvalid | PortUnprovided> => {
  const standalone: Array<Layer.Layer<never, ConfigInvalid | PortUnprovided>> =
    []
  const handsBack: Array<Layer.Layer<never, never, Enqueue>> = []

  if (uses.some((port) => AMBIENT.includes(port))) {
    standalone.push(
      AmbientPortsLive(row, {
        settings: options.settings,
        ...(options.rpm === undefined ? {} : { rpm: options.rpm }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.sink === undefined ? {} : { sink: options.sink }),
      }),
    )
  }
  for (const port of new Set(uses)) {
    switch (port) {
      case 'Identity':
        handsBack.push(IdentityLive(row))
        break
      case 'Facts':
        handsBack.push(FactsLive(row))
        break
      case 'Content':
        handsBack.push(ContentLive(row))
        break
      case 'Judgment':
        standalone.push(JudgmentLive(row))
        break
      case 'Receipts':
        standalone.push(ReceiptsLive(row))
        break
      case 'Read':
        standalone.push(ReadLive(row))
        break
      case 'Ai':
      case 'PluginDb':
        standalone.push(
          Layer.effectDiscard(
            Effect.fail(
              new PortUnprovided({
                reason: `${port} has no live implementation in this host yet`,
              }),
            ),
          ),
        )
        break
      case 'Config':
      case 'Secrets':
      case 'Log':
      case 'Http':
        break
    }
  }
  if (handsBack.length > 0) {
    standalone.push(Layer.provide(mergeList(handsBack), options.enqueue))
  }
  return mergeList(standalone)
}
