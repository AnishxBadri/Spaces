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

/** The settings page an account is listed on, by the job its product does. (D81) */
export const ACCOUNT_JOBS = [
  'email-calendar',
  'files',
  'meeting-notes',
] as const
export type AccountJob = (typeof ACCOUNT_JOBS)[number]

export const JOB_PAGE = {
  'email-calendar': '/settings/email-calendar',
  files: '/settings/files',
  'meeting-notes': '/settings/meeting-notes',
} as const satisfies Record<AccountJob, string>

export type ProductEntry = {
  readonly label: string
  /** The label under its provider's group: `Drive` under Google. */
  readonly name: string
  /** What an account is used for, as its row says it: `Mail · Calendar`. */
  readonly word: string
  readonly job: AccountJob
  readonly plugin: string
  readonly base: ReadonlyArray<string>
}

export const PRODUCTS = {
  // In the order an account page lists them: Mail, Calendar, then Drive.
  google: {
    gmail: {
      label: 'Gmail',
      name: 'Gmail',
      word: 'Mail',
      job: 'email-calendar',
      plugin: 'gmail',
      base: ['openid', 'email', 'gmail.readonly', 'gmail.send'],
    },
    calendar: {
      label: 'Google Calendar',
      name: 'Calendar',
      word: 'Calendar',
      job: 'email-calendar',
      plugin: 'calendar',
      base: ['openid', 'email', 'calendar.events.readonly'],
    },
    drive: {
      label: 'Google Drive',
      name: 'Drive',
      word: 'Drive',
      job: 'files',
      plugin: 'google-drive',
      base: ['openid', 'email', 'drive.file'],
    },
  },
  box: {
    box: {
      label: 'Box',
      name: 'Box',
      word: 'Box',
      job: 'files',
      plugin: 'box',
      base: ['root_readonly'],
    },
  },
} as const satisfies Record<ProviderId, Record<string, ProductEntry>>

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

/** A provider's products in registry order, with their ids. */
export function productsOf(
  provider: ProviderId,
): Array<{ readonly product: string; readonly entry: ProductEntry }> {
  const products: Readonly<Record<string, ProductEntry>> = PRODUCTS[provider]
  return Object.entries(products).map(([product, entry]) => ({
    product,
    entry,
  }))
}

/** The settings page a product's accounts are listed on; where a dance with no return lands. */
export function productPage(provider: ProviderId, product: string): string {
  const entry = productOf(provider, product)
  return JOB_PAGE[entry?.job ?? 'email-calendar']
}

/**
 * The start route a Connect control navigates to. With `scopes` (what
 * `hasScopes` named missing) it grows the held connection; with `returnTo`
 * the dance ends back on that path; with `account` the provider is asked to
 * preselect that address, so a product added from an account page lands on
 * the same account.
 */
export function connectHref(
  provider: ProviderId,
  product: string,
  scopes: ReadonlyArray<string> = [],
  returnTo: string | null = null,
  account: string | null = null,
): string {
  const query = new URLSearchParams({ product })
  if (scopes.length > 0) query.set('scopes', scopes.join(','))
  if (returnTo !== null) query.set('return', returnTo)
  if (account !== null) query.set('account', account)
  return `/api/connections/${provider}/start?${query.toString()}`
}
