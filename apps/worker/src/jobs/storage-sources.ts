import { Context, Schema } from 'effect'
import type { Effect, Scope } from 'effect'
import type { StorageSource } from '@spaces/sdk'

/**
 * The storage-source service a job asks for a provider's source by: the
 * installed plugin's `StorageSource`, bound to one connection. The live
 * Layer is the plugin host's (`storageSourcesLayer`); a job never reaches
 * the host itself.
 */

/** No source can be built: nothing installed, not wired, or the bundle's provider failed. */
export class StorageSourceUnavailable extends Schema.TaggedError<StorageSourceUnavailable>()(
  'StorageSourceUnavailable',
  { reason: Schema.String },
) {}

export type OpenedSource = {
  readonly integrationId: string
  readonly source: StorageSource
}

export class StorageSources extends Context.Service<
  StorageSources,
  {
    readonly open: (input: {
      readonly provider: string
      readonly connectionId: string
    }) => Effect.Effect<OpenedSource, StorageSourceUnavailable, Scope.Scope>
  }
>()('spaces/worker/jobs/StorageSources') {}
