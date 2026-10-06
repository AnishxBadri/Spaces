import type { FetchLike } from '@spaces/core/writes/ports/http'

/**
 * `SPACES_FAKE_PROVIDERS=1`: plugins whose provider has an in-repo fake talk
 * to it instead of the network, and run with no key configured. The dev and
 * demo environment; never on in production by accident, because the fakes
 * are found in the workspace and the image has none.
 *
 * - Off (anything but `1`), `loadFakeProviders` returns null and never
 *   imports the fakes, so the live path cannot reach one.
 * - `standInFor` is the one question the loader (the `requires.credential`
 *   check) and the grant (Http, Secrets) ask.
 */
export const FAKE_PROVIDERS_ENV = 'SPACES_FAKE_PROVIDERS'

/** What a fake gives one plugin: its Http transport, and a key for an unkeyed row. */
export type StandIn = {
  readonly fetch: FetchLike
  readonly secret: string
}

export type FakeProviders = {
  /** Null when this plugin's provider has no fake: it runs live. */
  readonly standIn: (pluginId: string) => StandIn | null
}

export const fakeProvidersOn = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => env[FAKE_PROVIDERS_ENV] === '1'

/** The fakes when the flag is on; null, with nothing imported, when it is off. */
export const loadFakeProviders = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FakeProviders | null> => {
  if (!fakeProvidersOn(env)) return null
  const { cassetteProviders } = await import('./registry')
  return cassetteProviders()
}

/** The fake standing in for `pluginId`, or null — the live provider. */
export const standInFor = (
  fakes: FakeProviders | null | undefined,
  pluginId: string,
): StandIn | null => fakes?.standIn(pluginId) ?? null
