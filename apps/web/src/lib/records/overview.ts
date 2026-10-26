import { DASH } from './readout-format'

/**
 * One readout a record's Overview may show: a day, a sum, a count. `null`,
 * a `—`, an empty string or a 0 is nothing to show, and the cell is left
 * out rather than printed empty.
 */
export type OverviewReadout = {
  label: string
  value: string | number | null
  /** Crimson: a value past its threshold (a close day gone by). */
  tone?: 'bad' | undefined
}

/** The readouts that have a value, in order, each value as printed. */
export function shownReadouts(
  readouts: ReadonlyArray<OverviewReadout>,
): Array<{ label: string; value: string; tone?: 'bad' | undefined }> {
  return readouts.flatMap((r) => {
    if (r.value === null || r.value === 0) return []
    const value = String(r.value).trim()
    if (value === '' || value === DASH || value === '0') return []
    return [r.tone === undefined ? { label: r.label, value } : { ...r, value }]
  })
}
