import type { ImportRefusal } from './ports.ts'

/**
 * How an `Import.stage` grid lands, shared by core's live port and the
 * testing kit so a plugin's test sees the answer the host gives.
 * - A list cell lands as text: `joinImportList`, which `splitImportList`
 *   reads back item for item. The import reader keeps one cell type.
 * - Per-row errors stay per-row: a row whose cells do not decode lands with
 *   no cells and its reason; a row with no usable ordinal is refused.
 */

const SEPARATORS = /[,;]/

/**
 * Items as one cell: comma-joined, an item quoted (`"…"`, quotes doubled)
 * when it holds a separator or opens with a quote. Reproduces a dialect's
 * own comma-joined cell when no item needed quoting.
 */
export const joinImportList = (items: ReadonlyArray<string>): string =>
  items
    .map((item) =>
      SEPARATORS.test(item) || item.trimStart().startsWith('"')
        ? `"${item.replaceAll('"', '""')}"`
        : item,
    )
    .join(',')

/**
 * A cell as its items: split on `,` or `;`, an item opening with `"` read to
 * its closing quote. Null when a quote is opened and not closed cleanly —
 * the caller then splits the plain way. Items are trimmed; blanks dropped.
 */
export const splitImportList = (cell: string): Array<string> | null => {
  const items: Array<string> = []
  let i = 0
  while (i <= cell.length) {
    while (i < cell.length && (cell[i] === ' ' || cell[i] === '\t')) i++
    if (cell[i] === '"') {
      let item = ''
      let j = i + 1
      for (;;) {
        if (j >= cell.length) return null
        if (cell[j] === '"') {
          if (cell[j + 1] === '"') {
            item += '"'
            j += 2
            continue
          }
          break
        }
        item += cell[j]
        j++
      }
      j++
      while (j < cell.length && (cell[j] === ' ' || cell[j] === '\t')) j++
      if (j < cell.length && !SEPARATORS.test(cell[j])) return null
      items.push(item.trim())
      i = j + 1
      continue
    }
    let j = i
    while (j < cell.length && !SEPARATORS.test(cell[j])) j++
    items.push(cell.slice(i, j).trim())
    i = j + 1
  }
  return items.filter((item) => item !== '')
}

/** One placed row: its cells as text, or null with the reason it is malformed. */
export type LandedRow = {
  readonly rowNum: number
  readonly cells: ReadonlyArray<string> | null
  readonly reason: string | null
}

export type LandedGrid = {
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<LandedRow>
  readonly refused: ReadonlyArray<ImportRefusal>
}

/** The whole grid is unreadable — no header to map, or no rows to read. */
export type GridUnreadable = { readonly unreadable: string }

const isRecord = (value: unknown): value is { readonly [k: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

/** A cell as text, or null when it is neither text nor a list of text. */
const cellText = (cell: unknown): string | null => {
  if (typeof cell === 'string') return cell
  if (isStringList(cell)) return joinImportList(cell)
  return null
}

/** Why a row's cells do not decode, or its cells padded to the width. */
const rowCells = (
  cells: unknown,
  width: number,
): { cells: Array<string> } | { reason: string } => {
  if (!Array.isArray(cells)) return { reason: 'the row has no list of cells' }
  if (cells.length > width)
    return {
      reason: `the row has ${cells.length} cells for ${width} columns`,
    }
  const out: Array<string> = []
  for (const [at, cell] of cells.entries()) {
    const text = cellText(cell)
    if (text === null)
      return {
        reason: `cell ${at + 1} is neither text nor a list of text`,
      }
    out.push(text)
  }
  while (out.length < width) out.push('')
  return { cells: out }
}

/**
 * The grid as rows the import reader takes. `grid` is `unknown` on purpose:
 * a bundle's types do not survive the import boundary, so every field is
 * decoded here.
 */
export const landImportGrid = (grid: unknown): LandedGrid | GridUnreadable => {
  if (!isRecord(grid)) return { unreadable: 'the grid is not an object' }
  const { columns, rows } = grid
  if (!isStringList(columns) || columns.length === 0)
    return { unreadable: 'the grid names no columns' }
  if (!Array.isArray(rows)) return { unreadable: 'the grid has no rows' }
  const placed: Array<LandedRow> = []
  const refused: Array<ImportRefusal> = []
  const seen = new Set<number>()
  for (const [at, row] of rows.entries()) {
    const ordinal = isRecord(row) ? row.ordinal : undefined
    if (
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 1
    ) {
      refused.push({
        ordinal: typeof ordinal === 'number' ? ordinal : 0,
        reason: `row ${at + 1} of the grid has no ordinal that is a positive whole number`,
      })
      continue
    }
    if (seen.has(ordinal)) {
      refused.push({ ordinal, reason: `ordinal ${ordinal} is used twice` })
      continue
    }
    seen.add(ordinal)
    const read = rowCells(isRecord(row) ? row.cells : undefined, columns.length)
    placed.push(
      'cells' in read
        ? { rowNum: ordinal, cells: read.cells, reason: null }
        : { rowNum: ordinal, cells: null, reason: read.reason },
    )
  }
  placed.sort((a, b) => a.rowNum - b.rowNum)
  return { columns, rows: placed, refused }
}
