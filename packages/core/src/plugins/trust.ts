import { createPublicKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Effect } from 'effect'
import { keyIdOf } from '@spaces/sdk/pack'
import { dataDir, workspaceRoot } from '../writes/vault/key.ts'
import type { PluginTrust } from './verify.ts'

/**
 * What this box trusts (sdk-21a; D54): the public keys baked into the image
 * and the development escape. Neither comes from the environment — the
 * required-env set stays `{DATABASE_URL, APP_URL}` — and neither from
 * `registry.json`, whose server would then choose the key.
 *
 * - **Keys:** `<root>/plugin-keys/<keyId>.pub`, PEM SPKI ed25519, one file
 *   per key so a rotation can trust two for one release. `<root>` is the
 *   workspace root in a checkout and the cwd (`/app`) in the image, which has
 *   no workspace marker. A cwd fallback is safe here where `dataDir()`'s
 *   would not be: a wrong directory trusts nothing and refuses everything.
 *   A file whose key does not hash to its name is skipped with a warning —
 *   never trusted under the id it borrowed.
 * - **Escape:** the marker `<dataDir()>/plugins/.allow-unsigned`, off by
 *   default, under the data directory and never the cwd.
 */

export const pluginKeysDir = (): string =>
  join(workspaceRoot() ?? process.cwd(), 'plugin-keys')

export const allowUnsignedMarker = (dir: string = dataDir()): string =>
  join(dir, 'plugins', '.allow-unsigned')

export const loadPluginTrust = Effect.fn('loadPluginTrust')(function* (
  options: { readonly keysDir?: string; readonly dataDir?: string } = {},
): Effect.fn.Return<PluginTrust> {
  const keysDir = options.keysDir ?? pluginKeysDir()
  const keys = new Map<string, KeyObject>()
  const names = existsSync(keysDir) ? readdirSync(keysDir) : []
  for (const name of names.filter((n) => n.endsWith('.pub')).sort()) {
    const claimed = name.slice(0, -'.pub'.length)
    const key = yield* Effect.try(() =>
      createPublicKey(readFileSync(join(keysDir, name), 'utf8')),
    ).pipe(Effect.option)
    if (key._tag === 'None') {
      yield* Effect.logWarning(
        `[plugins] ${name} is not a PEM public key; not trusted`,
      )
      continue
    }
    const actual = yield* Effect.try(() => keyIdOf(key.value)).pipe(
      Effect.orElseSucceed(() => null),
    )
    if (actual !== claimed) {
      yield* Effect.logWarning(
        `[plugins] ${name} holds ${actual ?? 'a non-ed25519 key'}, not ${claimed}; not trusted`,
      )
      continue
    }
    keys.set(claimed, key.value)
  }
  const allowUnsigned = existsSync(allowUnsignedMarker(options.dataDir))
  if (allowUnsigned) {
    yield* Effect.logWarning(
      '[plugins] ./data/plugins/.allow-unsigned is present — unsigned plugins will load',
    )
  }
  return { keys, allowUnsigned }
})
