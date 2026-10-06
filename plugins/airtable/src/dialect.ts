import type { ImportCell, ImportGrid, ImportRow } from '@spaces/sdk'

/**
 * Airtable's CSV export, read as a dialect — the pure half of the plugin.
 * - The file is RFC 4180: comma-delimited, `"`-quoted, `""` an escaped
 *   quote, CRLF or LF rows, a UTF-8 BOM first.
 * - A multi-select or a linked-record field is one cell of items joined by a
 *   bare `,`, an item quoted when it holds a comma or a quote. Linked records
 *   are display names and stay names: resolving them is core's mapping step.
 * - An attachment is `name (url)`, several joined by `,`; only the URL is
 *   data.
 * - A column is read as a list only when its cells say so: some cell joins
 *   two or more items, and no cell reads as prose (`, ` after a comma) or as
 *   a grouped number (`1,250`). Core lands a list as the cell it came from,
 *   so a column misread as a list still reads the same everywhere but in a
 *   multi-select.
 */

/** The rows of a CSV text, every row's cells verbatim. */
export const parseCsv = (text: string): Array<Array<string>> => {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ''
  let quoted = false
  let fieldStart = true
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (ch === ',') {
      row.push(field)
      field = ''
      fieldStart = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStart = true
    } else {
      field += ch
      fieldStart = false
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** One joined cell's items, and whether it reads as prose rather than a join. */
type ListRead = { readonly items: Array<string>; readonly prose: boolean }

/**
 * A cell as Airtable joins a list: items split on a bare `,`, a quoted item
 * read whole. Null when a quote is opened and not closed cleanly.
 */
export const readList = (cell: string): ListRead | null => {
  const items: Array<string> = []
  let prose = false
  let i = 0
  while (i <= cell.length) {
    if (cell[i] === '"') {
      let item = ''
      let j = i + 1
      for (;;) {
        if (j >= cell.length) return null
        if (cell[j] === '"' && cell[j + 1] === '"') {
          item += '"'
          j += 2
        } else if (cell[j] === '"') {
          break
        } else {
          item += cell[j]
          j++
        }
      }
      j++
      if (j < cell.length && cell[j] !== ',') return null
      items.push(item)
      i = j + 1
      continue
    }
    const end = cell.indexOf(',', i)
    const stop = end === -1 ? cell.length : end
    const item = cell.slice(i, stop)
    if (i > 0 && /^\s/.test(item)) prose = true
    items.push(item)
    i = stop + 1
  }
  return { items, prose }
}

/** `$1,250.00`, `-1,000`, `12,500,000` — a number Airtable grouped. */
const GROUPED_NUMBER = /^[-+]?[$€£¥]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/

/** `deck.pdf (https://…)`, several joined by `,`. */
const ATTACHMENTS =
  /^.+? \(https?:\/\/[^\s)]+\)(?:,.+? \(https?:\/\/[^\s)]+\))*$/

const ATTACHMENT_URL = / \((https?:\/\/[^\s)]+)\)/g

const attachmentUrls = (cell: string): Array<string> =>
  [...cell.matchAll(ATTACHMENT_URL)].map((m) => m[1])

export type ColumnKind = 'text' | 'list' | 'attachments'

/** How a column's cells are read, from the cells themselves. */
export const columnKind = (cells: ReadonlyArray<string>): ColumnKind => {
  const filled = cells.filter((c) => c.trim() !== '')
  if (filled.length === 0) return 'text'
  if (filled.every((c) => ATTACHMENTS.test(c))) return 'attachments'
  let joined = false
  for (const cell of filled) {
    if (GROUPED_NUMBER.test(cell.trim())) return 'text'
    const read = readList(cell)
    if (read === null) continue
    if (read.prose) return 'text'
    if (read.items.length > 1) joined = true
  }
  return joined ? 'list' : 'text'
}

/** One cell as the column reads it: a list of two or more is a list. */
const cellOf = (kind: ColumnKind, cell: string): ImportCell => {
  if (cell.trim() === '') return ''
  if (kind === 'attachments') {
    const urls = attachmentUrls(cell)
    return urls.length === 1 ? urls[0] : urls
  }
  if (kind === 'list') {
    const read = readList(cell)
    if (read === null || read.items.length < 2) return read?.items[0] ?? cell
    return read.items
  }
  return cell
}

export type AirtableGrid = ImportGrid & {
  /** Each column's reading, by header — what the job logs. */
  readonly kinds: ReadonlyArray<ColumnKind>
}

/**
 * The export as a grid: the first non-blank row is the header (Airtable
 * always writes one), every later non-blank row is data, numbered from 1 in
 * file order. Null for a file with no header.
 */
export const airtableGrid = (text: string): AirtableGrid | null => {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''))
  const header = rows.at(0)
  if (header === undefined) return null
  const data = rows.slice(1)
  const kinds = header.map((_, col) =>
    columnKind(data.map((r) => r.at(col) ?? '')),
  )
  const gridRows: Array<ImportRow> = data.map((r, i) => ({
    ordinal: i + 1,
    cells: r.map((cell, col) => cellOf(kinds.at(col) ?? 'text', cell)),
  }))
  return { columns: header, rows: gridRows, kinds }
}
