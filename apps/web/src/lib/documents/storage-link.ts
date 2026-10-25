import type { ProviderId } from '@spaces/core/providers/registry'

/**
 * Which storage provider a pasted link belongs to, by its host alone — the
 * plugin decides what the link names. Client-safe: the Files tab routes a
 * drop or a paste by it.
 */

export type StorageLinkProvider = {
  readonly provider: ProviderId
  /** The product whose connection fetches it. */
  readonly product: string
  /** The provider's word for itself on a row: "Open in Drive". */
  readonly label: string
}

const DRIVE: StorageLinkProvider = {
  provider: 'google',
  product: 'drive',
  label: 'Drive',
}

const BY_HOST: ReadonlyMap<string, StorageLinkProvider> = new Map([
  ['drive.google.com', DRIVE],
  ['docs.google.com', DRIVE],
])

/** The provider for an http(s) link on a storage host; null for anything else. */
export function storageLinkProvider(url: string): StorageLinkProvider | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  return BY_HOST.get(parsed.hostname) ?? null
}

/**
 * A pasted Drive *folder* link. The add row refuses it in place: a folder is
 * linked through Link a Drive folder, never fetched as a file.
 */
export function isFolderLink(url: string): boolean {
  if (storageLinkProvider(url) === null) return false
  return /\/folders\//.test(new URL(url).pathname)
}
