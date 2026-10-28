import { dayKey, formatDay } from '@spaces/core/format'
import type { AskThreadRow } from './types'

/** `/ask`'s thread list: rows grouped by local day, and each row's outcome. */

/** Threads grouped by local day (`YYYY-MM-DD`, a key; print it with `dayBand`), newest first. */
export function byDay(
  rows: ReadonlyArray<AskThreadRow>,
): Array<{ day: string; rows: Array<AskThreadRow> }> {
  const groups: Array<{ day: string; rows: Array<AskThreadRow> }> = []
  for (const r of rows) {
    const day = dayKey(r.createdAt)
    const last = groups.at(-1)
    if (last?.day === day) last.rows.push(r)
    else groups.push({ day, rows: [r] })
  }
  return groups
}

/** A day group's band label: `TODAY`, else the day in caps (`14 OCT`). */
export function dayBand(day: string, today: string): string {
  return day === dayKey(today) ? 'TODAY' : formatDay(day, today).toUpperCase()
}

/** What a thread came to, sentence case: cards applied, answers saved as notes. */
export function outcomeWords(r: AskThreadRow): string {
  const parts: Array<string> = []
  if (r.applied > 0) parts.push(`${String(r.applied)} applied`)
  if (r.saved > 0)
    parts.push(
      r.saved === 1 ? 'Saved as note' : `Saved as ${String(r.saved)} notes`,
    )
  return parts.join(' · ')
}
