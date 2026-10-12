import type { AskScopeChip } from './types'

/**
 * The page you are on as Ask's default scope chip: a record or a space, by
 * its path, named by what the page publishes to Cmd-K. Any other page asks
 * the whole workspace. (D70)
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RECORD = new RegExp(`^/(companies|people|deals|spaces)/(${UUID})(?:/|$)`)
const CUSTOM = new RegExp(`^/o/[^/]+/(${UUID})(?:/|$)`)

export function pageScope(
  pathname: string,
  name: string | null,
): AskScopeChip | null {
  if (name === null) return null
  const record = RECORD.exec(pathname)
  if (record) {
    const [whole, list, id] = record
    return {
      kind:
        list === 'spaces' ? 'space' : list === 'people' ? 'person' : 'record',
      id,
      name,
      href: whole.replace(/\/$/, ''),
    }
  }
  const custom = CUSTOM.exec(pathname)
  if (custom?.[1] !== undefined)
    return {
      kind: 'record',
      id: custom[1],
      name,
      href: custom[0].replace(/\/$/, ''),
    }
  return null
}
