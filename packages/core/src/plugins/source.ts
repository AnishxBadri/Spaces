import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Schema } from 'effect'
import { registrySchema } from '@spaces/sdk/pack'
import type { RegistryEntry } from '@spaces/sdk/pack'
import { workspaceRoot } from '../writes/vault/key.ts'

/**
 * Where plugin bytes come from: the bundled `registry.json` and the tarball
 * an entry names. Shared by the Integrations page and the first-boot
 * install, so both fetch the same way.
 * - The registry is never fetched — the image's snapshot is what an offline
 *   box sees.
 * - A tarball URL is `https:` or `file:`; a `file:` URL is how an image can
 *   ship tarballs beside its snapshot, and how tests serve fixtures.
 */

/** 64 MiB: a plugin is a bundle and a few migrations. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** `registry.json` at the workspace root; `/app/registry.json` in the image. */
export const bundledRegistryFile = (): string =>
  path.join(workspaceRoot() ?? process.cwd(), 'registry.json')

export class RegistryFileUnreadable extends Schema.TaggedError<RegistryFileUnreadable>()(
  'RegistryFileUnreadable',
  { message: Schema.String },
) {}

const unreadable = (message: string) => new RegistryFileUnreadable({ message })

/** Every entry in a registry file, or why it could not be read. */
export const readRegistryFile = Effect.fn('readRegistryFile')(function* (
  file: string = bundledRegistryFile(),
): Effect.fn.Return<Array<RegistryEntry>, RegistryFileUnreadable> {
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

/** The tarball's bytes: a read for `file:`, an HTTP GET otherwise. */
export const fetchPluginTarball = async (url: string): Promise<Uint8Array> => {
  if (url.startsWith('file:')) return readFile(fileURLToPath(url))
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_TARBALL_BYTES)
    throw new Error(`${url} is larger than a plugin can be`)
  return bytes
}
