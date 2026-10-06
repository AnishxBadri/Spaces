import { existsSync } from 'node:fs'
import path from 'node:path'
import { workspaceRoot } from '@spaces/core/writes/vault/key'
import { loadCassette } from './cassette'
import { makeFakeProvider } from './provider'
import type { FakeProvider } from './provider'
import type { FakeProviders, StandIn } from './switch'

/**
 * The fakes `SPACES_FAKE_PROVIDERS=1` stands in with: one per plugin that
 * commits `plugins/<id>/fixtures/cassette/cassette.json`, found in the
 * workspace. Outside a workspace (the image) there are none, so every
 * plugin runs live.
 */

/** The key `Secrets` hands a faked plugin with no credential bound. Not a key. */
export const fakeKeyFor = (pluginId: string): string => `fake-${pluginId}-key`

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

export const cassetteProviders = (
  root: string | null = workspaceRoot(),
): FakeProviders & {
  /** The fake behind a stand-in, for a test to drive; null when there is none. */
  readonly provider: (pluginId: string) => FakeProvider | null
} => {
  const made = new Map<string, FakeProvider | null>()
  const provider = (pluginId: string): FakeProvider | null => {
    const cached = made.get(pluginId)
    if (cached !== undefined) return cached
    let fake: FakeProvider | null = null
    if (root !== null && PLUGIN_ID.test(pluginId)) {
      const fixtures = path.join(root, 'plugins', pluginId, 'fixtures')
      if (existsSync(path.join(fixtures, 'cassette', 'cassette.json')))
        fake = makeFakeProvider(loadCassette(fixtures))
    }
    made.set(pluginId, fake)
    return fake
  }
  return {
    provider,
    standIn: (pluginId): StandIn | null => {
      const fake = provider(pluginId)
      return fake === null
        ? null
        : { fetch: fake.fetch, secret: fakeKeyFor(pluginId) }
    },
  }
}
