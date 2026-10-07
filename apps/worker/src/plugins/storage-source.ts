import { Context, Effect, Layer, Predicate } from 'effect'
import type { Scope } from 'effect'
import { PORTS } from '@spaces/sdk'
import type { StorageSource } from '@spaces/sdk'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { storageSourceIntegrationFor } from '@spaces/core/writes/connections/sources'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import type { LogSink } from '@spaces/core/writes/ports/log'
import type { FakeProviders } from './fakes/switch'
import { grantLayer } from './grant'
import type { PluginHost } from './host'
import { messageOf } from './loader'
import {
  StorageSourceUnavailable,
  StorageSources,
} from '../jobs/storage-sources'
import type { OpenedSource } from '../jobs/storage-sources'

/**
 * A storage-source plugin's provider, built for one acting user: core asks
 * for a provider and a connection, and gets the plugin's `StorageSource`
 * over the ambient ports.
 * - Secrets is bound to the given connection (the user who pasted the link,
 *   D66), never to the integration row's own `connection_id`.
 * - Built per call in the caller's scope, so its ports close with the job.
 */

const READ_MEMBERS = [
  'resolveLink',
  'listFolder',
  'getFolder',
  'getFile',
  'changes',
  'pickerConfig',
] as const

const isStorageSource = (value: unknown): value is StorageSource =>
  Predicate.isObject(value) &&
  READ_MEMBERS.every(
    (member) =>
      Predicate.hasProperty(value, member) &&
      Predicate.isFunction(value[member]),
  )

/** No enqueue: the ambient ports hand no work back. */
const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

export type StorageSourcesOptions = {
  readonly fakes?: FakeProviders | null
  readonly fetch?: FetchLike
  readonly sink?: LogSink
  /** Defaults to `<dataDir()>/plugins`. */
  readonly pluginsRoot?: string
}

/** One integration's provider, its Secrets bound to `connectionId`. */
export const storageSourceFor = Effect.fn('storageSourceFor')(function* (
  host: Pick<PluginHost, 'loaded'>,
  input: { readonly integrationId: string; readonly connectionId: string },
  options: StorageSourcesOptions = {},
): Effect.fn.Return<OpenedSource, StorageSourceUnavailable, Scope.Scope> {
  const plugin = host.loaded(input.integrationId)
  if (plugin === null)
    return yield* new StorageSourceUnavailable({
      reason: `integration ${input.integrationId} is not loaded in this worker`,
    })
  const provider = plugin.storageSource
  if (provider === undefined)
    return yield* new StorageSourceUnavailable({
      reason: `${plugin.manifest.id} exports no storage source`,
    })
  const context = yield* Layer.build(
    grantLayer(
      { ...plugin.row, connectionId: input.connectionId },
      ['Config', 'Secrets', 'Log', 'Http'],
      {
        settings: plugin.settings,
        enqueue: NoEnqueue,
        ...(plugin.manifest.http?.rateLimit === undefined
          ? {}
          : { rpm: plugin.manifest.http.rateLimit.rpm }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.sink === undefined ? {} : { sink: options.sink }),
        ...(options.fakes === undefined ? {} : { fakes: options.fakes }),
      },
    ),
  ).pipe(
    Effect.mapError(
      (error) =>
        new StorageSourceUnavailable({
          reason: `${plugin.manifest.id}: ${messageOf(error)}`,
        }),
    ),
  )
  const ambient = Context.pick(
    PORTS.Config,
    PORTS.Secrets,
    PORTS.Log,
    PORTS.Http,
  )(context)
  const built = yield* provider.pipe(
    Effect.provideContext(ambient),
    Effect.mapError(
      (error) =>
        new StorageSourceUnavailable({
          reason: `${plugin.manifest.id} could not build its storage source: ${messageOf(error)}`,
        }),
    ),
  )
  if (!isStorageSource(built))
    return yield* new StorageSourceUnavailable({
      reason: `${plugin.manifest.id}'s storage source is missing a read member`,
    })
  return { integrationId: input.integrationId, source: built }
})

/** The live service: the installed storage source for a provider, opened through the host. */
export const storageSourcesLayer = (
  host: Pick<PluginHost, 'loaded'>,
  options: StorageSourcesOptions = {},
): Layer.Layer<StorageSources> =>
  Layer.succeed(
    StorageSources,
    StorageSources.of({
      open: Effect.fn('StorageSources.open')(function* (input) {
        const found = yield* storageSourceIntegrationFor(
          input.provider,
          options.pluginsRoot === undefined
            ? {}
            : { pluginsRoot: options.pluginsRoot },
        ).pipe(
          Effect.mapError(
            (error) =>
              new StorageSourceUnavailable({
                reason: `could not read the installed plugins: ${messageOf(error.cause)}`,
              }),
          ),
        )
        if (found === null)
          return yield* new StorageSourceUnavailable({
            reason: `no storage-source plugin is installed for ${input.provider}`,
          })
        return yield* storageSourceFor(
          host,
          {
            integrationId: found.integrationId,
            connectionId: input.connectionId,
          },
          options,
        )
      }),
    }),
  )
