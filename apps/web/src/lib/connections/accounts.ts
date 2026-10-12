import { PROVIDER_IDS } from '@spaces/core/providers/registry'
import type { ProviderId } from '@spaces/core/providers/registry'
import type { AccountsView, ConnectionListRow } from './input'
import { productOf, productsOf } from './products'
import type { AccountJob } from './products'

/**
 * The accounts pages' grouping, client-safe: a connection is one product
 * row (D66); a page lists accounts — one provider address — by the job its
 * products do (D81). A Google address holding Gmail and Drive shows once on
 * Email & calendar and once on Files.
 */

export type Account = {
  readonly provider: ProviderId
  readonly email: string
  /** Every product row the account holds, whichever page lists it. */
  readonly rows: ReadonlyArray<ConnectionListRow>
  /** The rows of the page's job, in registry order. */
  readonly held: ReadonlyArray<ConnectionListRow>
}

const jobOf = (row: ConnectionListRow): AccountJob | null =>
  productOf(row.provider, row.product)?.job ?? null

/** Registry order of a provider's products; an unknown product sorts last. */
const productRank = (row: ConnectionListRow): number => {
  const i = productsOf(row.provider).findIndex((p) => p.product === row.product)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}

const byProduct = (a: ConnectionListRow, b: ConnectionListRow) =>
  productRank(a) - productRank(b)

const sameAccount = (a: ConnectionListRow, b: ConnectionListRow) =>
  a.provider === b.provider && a.externalEmail === b.externalEmail

const earliest = (rows: ReadonlyArray<ConnectionListRow>): string =>
  rows.reduce(
    (min, r) => (r.connectedAt < min ? r.connectedAt : min),
    rows.at(0)?.connectedAt ?? '',
  )

/** The account a row belongs to, seen from one job's page. */
export function accountOf(
  row: ConnectionListRow,
  job: AccountJob,
  connections: ReadonlyArray<ConnectionListRow>,
): Account {
  const rows = connections.filter((r) => sameAccount(r, row)).sort(byProduct)
  return {
    provider: row.provider,
    email: row.externalEmail,
    rows,
    held: rows.filter((r) => jobOf(r) === job),
  }
}

/** The accounts holding a product of `job`, earliest connected first. */
export function accountsFor(
  job: AccountJob,
  connections: ReadonlyArray<ConnectionListRow>,
): Array<Account> {
  const accounts: Array<Account> = []
  for (const row of connections) {
    if (jobOf(row) !== job) continue
    if (
      accounts.some(
        (a) => a.provider === row.provider && a.email === row.externalEmail,
      )
    )
      continue
    accounts.push(accountOf(row, job, connections))
  }
  return accounts.sort((a, b) =>
    earliest(a.held).localeCompare(earliest(b.held)),
  )
}

/** What the account is used for on this page, in words: `Mail · Calendar`. */
export function wordsOf(rows: ReadonlyArray<ConnectionListRow>): string {
  return rows
    .map((r) => productOf(r.provider, r.product)?.word ?? r.product)
    .join(' · ')
}

/**
 * The Default mark: the account new email sends from, the earliest-connected
 * live mail row's. Null with no mail account.
 */
export function defaultMailAccount(
  connections: ReadonlyArray<ConnectionListRow>,
): { provider: ProviderId; email: string } | null {
  const mail = connections
    .filter((r) => r.product === 'gmail' && r.status !== 'revoked')
    .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt))
    .at(0)
  return mail === undefined
    ? null
    : { provider: mail.provider, email: mail.externalEmail }
}

export type SyncState = {
  readonly tone: 'ok' | 'error' | 'revoked'
  /** `synced 10-09`, `never synced`, the provider's reason, or `revoked`. */
  readonly text: string
}

/** One line for a set of rows: an error wins, then revoked, then the latest sync. */
export function syncStateOf(rows: ReadonlyArray<ConnectionListRow>): SyncState {
  const failed = rows.find((r) => r.status === 'error')
  if (failed !== undefined)
    return {
      tone: 'error',
      text: failed.errorReason ?? 'the provider gave no reason',
    }
  if (rows.length > 0 && rows.every((r) => r.status === 'revoked'))
    return { tone: 'revoked', text: 'revoked' }
  const latest = rows
    .map((r) => r.lastSyncAt)
    .filter((at) => at !== null)
    .sort()
    .at(-1)
  return {
    tone: 'ok',
    text:
      latest === undefined ? 'never synced' : `synced ${latest.slice(5, 10)}`,
  }
}

/**
 * What a reader can do to add a product, decided by its plugin:
 * - `connect` when the plugin is installed and the provider has a client;
 * - `configure` (an admin) when the client is missing;
 * - `install` (an admin) when the registry offers the plugin;
 * - `ask` (a member) for either of those;
 * - `unavailable` when no plugin exists to install.
 */
export type Offer =
  | { readonly kind: 'connect'; readonly product: string }
  | { readonly kind: 'configure' }
  /** `plugin` is the registry's plugin id, for its row in the catalogue. */
  | { readonly kind: 'install'; readonly plugin: string }
  | { readonly kind: 'ask' }
  | { readonly kind: 'unavailable' }

/** The offer for the first of `products` a reader can act on. */
export function offerFor(
  provider: ProviderId,
  products: ReadonlyArray<string>,
  view: Pick<AccountsView, 'configured' | 'installed' | 'offered'>,
  isAdmin: boolean,
): Offer {
  const plugins = products.flatMap((product) => {
    const entry = productOf(provider, product)
    return entry === null ? [] : [{ product, plugin: entry.plugin }]
  })
  const installed = plugins.find((p) => view.installed.includes(p.plugin))
  if (installed !== undefined) {
    if (view.configured.includes(provider))
      return { kind: 'connect', product: installed.product }
    return isAdmin ? { kind: 'configure' } : { kind: 'ask' }
  }
  const offered = plugins.find((p) => view.offered.includes(p.plugin))
  if (offered !== undefined)
    return isAdmin
      ? { kind: 'install', plugin: offered.plugin }
      : { kind: 'ask' }
  return { kind: 'unavailable' }
}

/** The providers with a product of `job`, each with those products. */
export function providersFor(
  job: AccountJob,
): Array<{ provider: ProviderId; products: Array<string> }> {
  return PROVIDER_IDS.flatMap((provider) => {
    const products = productsOf(provider)
      .filter((p) => p.entry.job === job)
      .map((p) => p.product)
    return products.length === 0 ? [] : [{ provider, products }]
  })
}

/**
 * Whether the provider limits this account's grant to days: Google says
 * when a refresh token lapses only for an OAuth client in Testing mode,
 * whose tokens last 7 days.
 */
export function testingModeOf(account: Account): boolean {
  return (
    account.provider === 'google' &&
    account.held.some((r) => r.refreshExpiresAt !== null)
  )
}

/** The account's mail row, when it holds one: where a mail sync's settings hang. */
export function mailRowOf(account: Account): ConnectionListRow | null {
  return account.rows.find((r) => r.product === 'gmail') ?? null
}
