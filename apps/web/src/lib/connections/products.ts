import { PROVIDERS } from '@spaces/core/providers/registry'
import type { ProviderId, ProviderScope } from '@spaces/core/providers/registry'

/**
 * A connection is per product (D66): Drive, Calendar and Gmail each carry
 * their own consent under the one Google client; Box is its own product.
 * Client-safe data, read by the start route and the Connect control.
 * - `plugin` is the registry `ProviderScope.plugin` whose scopes the
 *   product may ask for, beside core's own (`plugin: null`). A product's
 *   consent screen never lists another product's scopes.
 * - `base` is what Connect asks for when no scopes are named.
 */

export type ProductEntry = {
  readonly label: string
  /** The label under its provider's group: `Drive` under Google. */
  readonly name: string
  readonly plugin: string
  readonly base: ReadonlyArray<string>
}

export const PRODUCTS = {
  google: {
    drive: {
      label: 'Google Drive',
      name: 'Drive',
      plugin: 'google-drive',
      base: ['openid', 'email', 'drive.file'],
    },
    calendar: {
      label: 'Google Calendar',
      name: 'Calendar',
      plugin: 'calendar',
      base: ['openid', 'email', 'calendar.events.readonly'],
    },
    gmail: {
      label: 'Gmail',
      name: 'Gmail',
      plugin: 'gmail',
      base: ['openid', 'email', 'gmail.readonly', 'gmail.send'],
    },
  },
  box: {
    box: { label: 'Box', name: 'Box', plugin: 'box', base: ['root_readonly'] },
  },
} as const satisfies Record<ProviderId, Record<string, ProductEntry>>

/** The product the settings Connect control starts, one per provider. */
export const CONNECT_PRODUCT = {
  google: 'drive',
  box: 'box',
} as const satisfies Record<ProviderId, string>

export function productOf(
  provider: ProviderId,
  product: string,
): ProductEntry | null {
  const products: Readonly<Record<string, ProductEntry>> = PRODUCTS[provider]
  return Object.hasOwn(products, product) ? products[product] : null
}

/** The product's own scopes in its base set — what its row prints. */
export function productScopes(provider: ProviderId, product: string): string[] {
  const entry = productOf(provider, product)
  if (entry === null) return []
  const vocabulary: ReadonlyArray<ProviderScope> = PROVIDERS[provider].scopes
  return entry.base.filter((value) =>
    vocabulary.some((s) => s.value === value && s.plugin !== null),
  )
}

/**
 * The start route a Connect control navigates to. With `scopes` (what
 * `hasScopes` named missing) it grows the held connection; with `returnTo`
 * the dance ends back on that path.
 */
export function connectHref(
  provider: ProviderId,
  product: string,
  scopes: ReadonlyArray<string> = [],
  returnTo: string | null = null,
): string {
  const query = new URLSearchParams({ product })
  if (scopes.length > 0) query.set('scopes', scopes.join(','))
  if (returnTo !== null) query.set('return', returnTo)
  return `/api/connections/${provider}/start?${query.toString()}`
}
