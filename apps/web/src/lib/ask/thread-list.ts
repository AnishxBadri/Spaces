import type { AskThreadRow } from './types'

/** `/ask`'s thread list: rows grouped by local day, and each row's outcome. */

const dayOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Threads grouped by local day, newest first. */
export function byDay(
  rows: ReadonlyArray<AskThreadRow>,
): Array<{ day: string; rows: Array<AskThreadRow> }> {
  const groups: Array<{ day: string; rows: Array<AskThreadRow> }> = []
  for (const r of rows) {
    const day = dayOf(r.createdAt)
    const last = groups.at(-1)
    if (last?.day === day) last.rows.push(r)
    else groups.push({ day, rows: [r] })
  }
  return groups
}

/** What a thread came to: cards applied, answers saved as notes. */
export function outcomeWords(r: AskThreadRow): string {
  const parts: Array<string> = []
  if (r.applied > 0) parts.push(`${r.applied} applied`)
  if (r.saved > 0)
    parts.push(r.saved === 1 ? 'saved as note' : `${r.saved} saved`)
  return parts.join(' · ')
}
