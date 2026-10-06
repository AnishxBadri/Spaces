/**
 * What a pasted URL says about a Drive item before Drive is asked: its id,
 * and whether the link's form names a folder, a file, or either
 * (`/open?id=`). Null for anything that is not one of the six forms — a
 * Dropbox link, a Drive home page, a search — rather than a guess.
 */
export type ParsedLink = {
  readonly id: string
  readonly form: 'file' | 'folder' | 'either'
}

const HOSTS = new Set(['drive.google.com', 'docs.google.com'])

/** A Drive id: letters, digits, `-` and `_`. */
const ID = '([\\w-]+)'

/** `/u/<n>` is the account switcher's segment; it can sit in any form. */
const ACCOUNT = '(?:/u/\\d+)?'

const FORMS: ReadonlyArray<{
  readonly path: RegExp
  readonly form: ParsedLink['form']
}> = [
  { path: new RegExp(`^/file${ACCOUNT}/d/${ID}(?:/|$)`), form: 'file' },
  {
    path: new RegExp(`^/drive${ACCOUNT}/folders/${ID}(?:/|$)`),
    form: 'folder',
  },
  {
    path: new RegExp(
      `^/(?:document|spreadsheets|presentation)${ACCOUNT}/d/${ID}(?:/|$)`,
    ),
    form: 'file',
  },
]

const OPEN_ID = /^[\w-]+$/

export const parseDriveLink = (url: string): ParsedLink | null => {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (!HOSTS.has(parsed.hostname)) return null
  for (const { path, form } of FORMS) {
    const id = path.exec(parsed.pathname)?.[1]
    if (id !== undefined) return { id, form }
  }
  if (parsed.pathname === '/open') {
    const id = parsed.searchParams.get('id')
    if (id !== null && OPEN_ID.test(id)) return { id, form: 'either' }
  }
  return null
}
