import type { AskFindRow, AskFindTable, AskSavedWatch } from './types'

/**
 * A Find table as the thread draws it, pure so the table and its tests read
 * one set of rules.
 * - Past `FIND_FOLD` rows the table folds; its foot prints what is folded
 *   and what is hidden once.
 * - A row ends on its state word and at most one action: Add for an
 *   unknown company, File here for one held elsewhere with a space in
 *   scope. A filed row has no control.
 */

export const FIND_FOLD = 12

/** What the reader did to a row, before the table is read again. */
export type FindAfter =
  | { act: 'added'; entityId: string; created: boolean; filed: boolean }
  | { act: 'dismissed' }

/** The foot: `+13 more · 2 hidden`; null when nothing is folded or hidden. */
export function foldLine(
  table: AskFindTable,
  expanded: boolean,
): string | null {
  const more = expanded ? 0 : Math.max(0, table.rows.length - FIND_FOLD)
  const parts = [
    ...(more > 0 ? [`+${String(more)} more`] : []),
    ...(table.hidden > 0 ? [`${String(table.hidden)} hidden`] : []),
  ]
  return parts.length === 0 ? null : parts.join(' · ')
}

/** The rows shown: the first `FIND_FOLD` until the reader unfolds. */
export const shownRows = (
  table: AskFindTable,
  expanded: boolean,
): ReadonlyArray<AskFindRow> =>
  expanded ? table.rows : table.rows.slice(0, FIND_FOLD)

/** The one action a row offers at rest; null for none. */
export function rowAction(
  row: AskFindRow,
  table: AskFindTable,
): 'add' | 'file' | null {
  if (row.standing === 'unknown') return 'add'
  if (row.standing === 'held' && table.space !== null) return 'file'
  return null
}

/** What the row's `···` holds: Add and file here, and Dismiss, each with a space. */
export function rowMenu(
  row: AskFindRow,
  table: AskFindTable,
): ReadonlyArray<'add-and-file' | 'dismiss'> {
  if (table.space === null || row.standing === 'filed') return []
  return row.standing === 'unknown' ? ['add-and-file', 'dismiss'] : ['dismiss']
}

/** The state word at rest: filed and held say so; a web result says nothing. */
export function restWord(row: AskFindRow): string | null {
  return row.standing === 'unknown' ? null : row.standing
}

/** A source link's words: the page's host. */
export function sourceLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The question Find companies prefills, from the space's criteria. */
export function findQuestion(space: string, criteria: string | null): string {
  const rule = criteria?.trim() ?? ''
  return rule === ''
    ? `Find companies that belong in ${space}.`
    : `Find companies that match: ${rule}`
}

/** The longest name Save as watch offers to create a space with. */
const SPACE_NAME_MAX = 60

/**
 * The space Save as watch offers to create from a question: its words on
 * one line, cut at a word under 60 characters, the closing stop dropped.
 */
export function spaceNameFrom(question: string): string {
  const line = question
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.?!]+$/, '')
  if (line.length <= SPACE_NAME_MAX) return line
  const cut = line.slice(0, SPACE_NAME_MAX)
  const at = cut.lastIndexOf(' ')
  return (at > 20 ? cut.slice(0, at) : cut).trim()
}

/** Look for, prefilled: the question, blank when it is the space's criteria. */
export function lookForFrom(question: string, criteria: string | null): string {
  const q = question.trim()
  return criteria !== null && criteria.trim() !== '' && q === criteria.trim()
    ? ''
    : q
}

/** The engine a table was found through, when it can watch; else the first. */
export function engineFor(
  table: AskFindTable,
  engines: ReadonlyArray<{ integrationId: string }>,
): string | null {
  const offered = new Set(engines.map((e) => e.integrationId))
  const via = table.rows.find((r) => offered.has(r.via.integrationId))
  return via?.via.integrationId ?? engines.at(0)?.integrationId ?? null
}

/** The thread's line for a saved table. */
export function savedWatchLine(saved: AskSavedWatch): string {
  return saved.deleted === true
    ? `Saved as a watch on ${saved.spaceName} · watch deleted`
    : `Saved as a watch on ${saved.spaceName}`
}
