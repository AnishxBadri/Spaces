import { Effect, Schema } from 'effect'
import { readRegistryFile } from '@spaces/core/plugins/source'
import type { RegistryEntry } from '@spaces/sdk/pack'

/**
 * The committed plugin registry, read by web: `registry.json` at the
 * workspace root, `/app/registry.json` in the image. Never fetched — the
 * image's snapshot is what an offline box sees. Core reads the file
 * (`readRegistryFile`), which the worker's boot autoupdate shares.
 */

export type RegistrySource = {
  /** Defaults to `registry.json` at the workspace root (`/app` in the image). */
  readonly registryFile?: string
  /** Defaults to an HTTP GET (or a read, for a `file:` URL). */
  readonly fetchTarball?: (url: string) => Promise<Uint8Array>
  /** Defaults to the image's `plugin-keys/` (`pluginKeysDir`). */
  readonly keysDir?: string
  /** Defaults to `dataDir()`. */
  readonly dataDir?: string
}

export class RegistryUnreadable extends Schema.TaggedError<RegistryUnreadable>()(
  'RegistryUnreadable',
  { message: Schema.String },
) {}

/** Every entry in the registry, or why it could not be read. */
export const readRegistryProgram = Effect.fn('readRegistryProgram')(function* (
  source: RegistrySource = {},
): Effect.fn.Return<Array<RegistryEntry>, RegistryUnreadable> {
  return yield* readRegistryFile(source.registryFile).pipe(
    Effect.mapError((e) => new RegistryUnreadable({ message: e.message })),
  )
})

/** Every registry entry, for the ledger's update badge; none when the file cannot be read. */
export const registryEntriesProgram = Effect.fn('registryEntriesProgram')(
  function* (
    source: RegistrySource = {},
  ): Effect.fn.Return<ReadonlyArray<RegistryEntry>> {
    return yield* readRegistryProgram(source).pipe(
      Effect.orElseSucceed(() => []),
    )
  },
)
