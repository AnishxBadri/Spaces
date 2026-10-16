/**
 * What a pasted URL says about a Box item before Box is asked: a folder or
 * file id, or a shared link Box must resolve. Null for anything that is not
 * one of Box's forms — a Drive link, Box's home page, a search.
 *
 * - `/folder/<id>`, `/file/<id>` and `/notes/<id>` (a Box Note opens there),
 *   on `app.box.com` or an enterprise's `<name>.app.box.com`.
 * - `/s/<name>` and `/v/<vanity>` are shared links, on any Box host.
 * - `/s/<name>/file/<id>` (a file opened inside a shared folder) names
 *   the file by id: a collaborator reaches it directly.
 */
export type ParsedBoxLink =
  | { readonly kind: 'folder' | 'file'; readonly id: string }
  | { readonly kind: 'shared'; readonly url: string }

/** Box hosts that never carry an item link. */
const NOT_ITEM_HOSTS = new Set([
  'account.box.com',
  'api.box.com',
  'upload.box.com',
  'developer.box.com',
  'support.box.com',
])

const isAppHost = (host: string) =>
  host === 'app.box.com' || host.endsWith('.app.box.com')

const isBoxHost = (host: string) =>
  (host === 'box.com' || host.endsWith('.box.com')) && !NOT_ITEM_HOSTS.has(host)

const ITEM = /^\/(folder|file|notes)\/(\d+)\/?$/
const SHARED = /^\/(s|v)\/([\w-]+)(?:\/(file|folder)\/(\d+))?\/?$/

export const parseBoxLink = (url: string): ParsedBoxLink | null => {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  if (!isBoxHost(host)) return null
  const item = ITEM.exec(parsed.pathname)
  if (item !== null && isAppHost(host))
    return { kind: item[1] === 'folder' ? 'folder' : 'file', id: item[2] }
  const shared = SHARED.exec(parsed.pathname)
  if (shared === null) return null
  const [form, name, innerKind, innerId] = [1, 2, 3, 4].map((i) => shared.at(i))
  if (innerKind !== undefined && innerId !== undefined)
    return { kind: innerKind === 'folder' ? 'folder' : 'file', id: innerId }
  if (form === undefined || name === undefined) return null
  return { kind: 'shared', url: `https://${host}/${form}/${name}` }
}
