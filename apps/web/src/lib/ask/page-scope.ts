import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { AskScopeChip } from './types'

/**
 * The page you are on as Ask's default scope chip: a record or a space, by
 * its path, named by what the page publishes to Cmd-K; a saved view or an
 * open file, by what that surface publishes (`useAskSubject`). Any other
 * page asks the whole workspace. (D70)
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

/** The most chips a question carries; the server refuses more. */
export const SCOPE_MAX = 4

/** How one chip is told apart from another. */
export const chipKey = (c: AskScopeChip) => `${c.kind}:${c.id ?? ''}`

/**
 * The dock's chips: the page's own first unless it was removed, then the
 * ones `@` added, each once, at most `SCOPE_MAX`.
 */
export function dockScope(
  page: AskScopeChip | null,
  cleared: string | null,
  mentioned: ReadonlyArray<AskScopeChip>,
): ReadonlyArray<AskScopeChip> {
  const all = [
    ...(page === null || chipKey(page) === cleared ? [] : [page]),
    ...mentioned,
  ]
  return all
    .filter((c, i) => all.findIndex((d) => chipKey(d) === chipKey(c)) === i)
    .slice(0, SCOPE_MAX)
}

/**
 * The chips after an `@` pick: the pick last, once, the oldest giving way
 * past `max`. The dock and `/ask` both add through it.
 */
export function withMention(
  chips: ReadonlyArray<AskScopeChip>,
  chip: AskScopeChip,
  max: number = SCOPE_MAX,
): ReadonlyArray<AskScopeChip> {
  const rest = chips.filter((c) => chipKey(c) !== chipKey(chip))
  return [...rest, chip].slice(-max)
}

// ---------------------------------------------------------------------------
// A page's subject beyond its path: the saved view a list shows, the file a
// preview has open. The newest mounted one leads, as a page's verbs do.

let subjects: Array<{ current: AskScopeChip | null }> = []
let subjectSnapshot: AskScopeChip | null = null
const subjectListeners = new Set<() => void>()

function publishSubject() {
  subjectSnapshot = subjects.find((s) => s.current !== null)?.current ?? null
  for (const l of subjectListeners) l()
}

function subscribeSubject(cb: () => void) {
  subjectListeners.add(cb)
  return () => {
    subjectListeners.delete(cb)
  }
}

/** The subject a mounted view or file published; null when none did. */
export function usePageSubject(): AskScopeChip | null {
  return useSyncExternalStore(
    subscribeSubject,
    () => subjectSnapshot,
    () => null,
  )
}

/**
 * Publish this surface's subject as Ask's default chip while it is mounted:
 * a saved view on a list, a file in its preview. Null publishes nothing.
 */
export function useAskSubject(chip: AskScopeChip | null) {
  const signature = chip === null ? '' : `${chipKey(chip)}\u0000${chip.name}`
  const latest = useRef(chip)
  latest.current = chip
  useEffect(() => {
    if (signature === '') return
    const reg = { current: latest.current }
    subjects = [reg, ...subjects]
    publishSubject()
    return () => {
      subjects = subjects.filter((s) => s !== reg)
      publishSubject()
    }
  }, [signature])
}
