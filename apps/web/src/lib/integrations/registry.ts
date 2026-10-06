import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Effect, Schema } from 'effect'
import { compareVersions, newestPerPlugin } from '@spaces/core/plugins/registry'
import { workspaceRoot } from '@spaces/core/writes/vault/key'
import { registrySchema } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'

/**
 * The committed plugin registry, read by web: `registry.json` at the
 * workspace root, `/app/registry.json` in the image. Never fetched — the
 * image's snapshot is what an offline box sees.
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

const unreadable = (message: string) => new RegistryUnreadable({ message })

export const registryFile = (): string =>
  path.join(workspaceRoot() ?? process.cwd(), 'registry.json')

/** Every entry in the registry, or why it could not be read. */
export const readRegistryProgram = Effect.fn('readRegistryProgram')(function* (
  source: RegistrySource = {},
): Effect.fn.Return<Array<RegistryEntry>, RegistryUnreadable> {
  const file = source.registryFile ?? registryFile()
  const text = yield* Effect.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: () => unreadable(`The plugin registry (${file}) could not be read`),
  })
  const parsed = registrySchema.safeParse(
    yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => unreadable(`The plugin registry (${file}) is not JSON`),
    }),
  )
  if (!parsed.success)
    return yield* unreadable(`The plugin registry (${file}) is invalid`)
  return parsed.data
})

/** The newest registry version per plugin id, for the ledger's update badge. */
export const newestVersionsProgram = Effect.fn('newestVersionsProgram')(
  function* (
    source: RegistrySource = {},
  ): Effect.fn.Return<ReadonlyMap<string, string>> {
    const entries = yield* readRegistryProgram(source).pipe(
      Effect.orElseSucceed(() => []),
    )
    return new Map(newestPerPlugin(entries).map((e) => [e.id, e.version]))
  },
)

/** The newer version, when the registry has one past `installed`. */
export const updateOf = (
  newest: ReadonlyMap<string, string>,
  pluginId: string,
  installed: string,
): string | null => {
  const version = newest.get(pluginId)
  return version !== undefined && compareVersions(version, installed) > 0
    ? version
    : null
}
