/**
 * Providers a member connects by pasting their own key rather than through
 * an OAuth dance (D78): no client, no scopes, no refresh. Pure data,
 * client-safe; the key becomes an `account_connection` row like a grant.
 * - `product` is stored on the row; `plugin` is the manifest id whose
 *   schedule jobs run once per such connection.
 * - `api` is where core reads the key's owner and folders when the person
 *   pastes it and ticks folders — never plugin code, which runs only in the
 *   worker.
 */

export type KeyedProviderEntry = {
  readonly label: string
  readonly product: string
  readonly plugin: string
  readonly api: string
  /** What a key looks like, for the field's placeholder. */
  readonly keyHint: string
}

export const KEYED_PROVIDERS = {
  granola: {
    label: 'Granola',
    product: 'notes',
    plugin: 'granola',
    api: 'https://public-api.granola.ai/v1',
    keyHint: 'grn_…',
  },
} as const satisfies Record<string, KeyedProviderEntry>

export type KeyedProviderId = keyof typeof KEYED_PROVIDERS

export const KEYED_PROVIDER_IDS: ReadonlyArray<KeyedProviderId> = ['granola']

export function isKeyedProvider(value: string): value is KeyedProviderId {
  return Object.hasOwn(KEYED_PROVIDERS, value)
}
