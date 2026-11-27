import { DOCUMENT_KIND_LABELS, formatBytes } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import {
  dayKey,
  formatDay,
  formatNumber,
  formatTime,
  weekdayOf,
} from '@spaces/core/format'
import { weekBand } from '#/lib/timeline/weeks'
import { FROM_LABELS } from './files-filter'
import type { FilesFrom, FilesGroup } from './files-filter'
import { KIND_ORDER, fileType } from './files-tab'

/**
 * What the Files page prints about its rows, as pure functions: the kind
 * tabs, the bands, a row's day and its facts lane. Client-safe, so the
 * page and the list query's test share one copy.
 */

/** The page's folder tabs: every file, then one per kind. */
export type FilesTab = 'all' | DocumentKind

export const FILES_TABS: ReadonlyArray<FilesTab> = ['all', ...KIND_ORDER]

const TAB_LABELS: Readonly<Record<FilesTab, string>> = {
  all: 'All',
  deck: 'Decks',
  cap_table: 'Cap tables',
  dd: 'Diligence',
  legal: 'Legal',
  article: 'Articles',
  other: 'Other',
}

/** A tab as its folder tab reads: `Decks`, `Cap tables`. */
export const filesTabLabel = (tab: FilesTab): string => TAB_LABELS[tab]

/** What a row's band and lanes read. */
type Dated = { readonly createdAt: string; readonly unfiled: boolean }

export type FilesBand<T> = {
  /** Stable across renders: `unfiled`, `today`, `2026-09`. */
  readonly key: string
  /** As the band prints it, before `label-caps` capitalises it. */
  readonly label: string
  readonly rows: Array<T>
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/**
 * The rows in their bands, in the order the page draws them: `Unfiled`
 * first whatever its rows' days, then `Today`, `This week`, `Last week` and
 * one band per month, newest first. A month outside `today`'s year carries
 * its year. A row dated after `today` (a clock ahead of the reader's) is
 * today's. Rows keep their order inside a band, so a sort by name sorts
 * within each; empty bands are left out.
 */
export function filesBands<T extends Dated>(
  rows: ReadonlyArray<T>,
  today: string,
): Array<FilesBand<T>> {
  const bands: Array<FilesBand<T>> = []
  const at = (key: string, label: string): Array<T> => {
    const found = bands.find((b) => b.key === key)
    if (found !== undefined) return found.rows
    const band: FilesBand<T> = { key, label, rows: [] }
    bands.push(band)
    return band.rows
  }
  // The fixed bands go first in their own order, whatever order the rows
  // arrive in; months follow, newest first, as the rows are.
  const fixed = ['unfiled', 'today', 'this-week', 'last-week']
  const year = dayKey(today).slice(0, 4)
  for (const row of rows) {
    const day = dayKey(row.createdAt)
    if (row.unfiled) at('unfiled', 'Unfiled').push(row)
    else if (day >= today) at('today', 'Today').push(row)
    else {
      const week = weekBand(row.createdAt, today)
      if (week === 'This week') at('this-week', 'This week').push(row)
      else if (week === 'Last week') at('last-week', 'Last week').push(row)
      else {
        const month = MONTHS[Number(day.slice(5, 7)) - 1]
        const y = day.slice(0, 4)
        at(day.slice(0, 7), y === year ? month : `${month} ${y}`).push(row)
      }
    }
  }
  const rank = (b: FilesBand<T>) => {
    const i = fixed.indexOf(b.key)
    return i < 0 ? fixed.length : i
  }
  // Months by their key, newest first, whatever the rows' sort.
  return bands.sort(
    (x, y) => rank(x) - rank(y) || (x.key < y.key ? 1 : x.key > y.key ? -1 : 0),
  )
}

/** What a row's group band reads off it. */
type Grouped = {
  readonly id: string
  readonly unfiled: boolean
  readonly records: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly kind: string
  }>
  readonly spaces: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly from: FilesFrom
  readonly addedBy: { readonly id: string; readonly name: string } | null
}

/** A band when the list is grouped by something other than the date. */
export type FilesGroupBand<T> = FilesBand<T> & {
  /** The record's or the space's kind, for its mark; null for the rest. */
  readonly kind: string | null
}

/**
 * The rows in the bands a grouping draws: `Unfiled` first, as in every
 * grouping, then one band per record or space, source or adder, in the
 * order their first row comes. A file under two records stands in both.
 * Ungrouped, the filed rows are one band with no label.
 */
export function filesGroupBands<T extends Grouped>(
  rows: ReadonlyArray<T>,
  group: Exclude<FilesGroup, 'date'>,
): Array<FilesGroupBand<T>> {
  const bands: Array<FilesGroupBand<T>> = []
  const at = (key: string, label: string, kind: string | null) => {
    const found = bands.find((b) => b.key === key)
    if (found !== undefined) return found.rows
    const band: FilesGroupBand<T> = { key, label, kind, rows: [] }
    bands.push(band)
    return band.rows
  }
  for (const row of rows) {
    if (row.unfiled) {
      at('unfiled', 'Unfiled', null).push(row)
      continue
    }
    switch (group) {
      case 'record':
        for (const r of row.records) at(r.id, r.name, r.kind).push(row)
        for (const s of row.spaces) at(s.id, s.name, 'space').push(row)
        break
      case 'source':
        at(row.from, FROM_LABELS[row.from], null).push(row)
        break
      case 'adder':
        at(
          row.addedBy?.id ?? 'none',
          row.addedBy?.name ?? 'A connection',
          null,
        ).push(row)
        break
      case 'none':
        at('all', '', null).push(row)
        break
    }
  }
  return bands.sort(
    (x, y) => Number(y.key === 'unfiled') - Number(x.key === 'unfiled'),
  )
}

/**
 * A row's day lane: the time today, the weekday this week, else the day
 * (`9 Oct`, `4 Oct 2024`).
 */
export function fileDay(at: string, now: string): string {
  const today = dayKey(now)
  if (dayKey(at) >= today) return formatTime(at)
  return weekBand(at, today) === 'This week'
    ? weekdayOf(at)
    : formatDay(at, today)
}

/** What the facts lane reads off a row. */
type Faceted = {
  readonly kind: DocumentKind
  readonly filename: string
  readonly mime: string | null
  readonly externalUrl: string | null
  readonly sizeBytes: number | null
  readonly pages: number | null
  readonly words: number | null
}

const counted = (n: number, one: string) =>
  `${formatNumber(n, 0)} ${one}${n === 1 ? '' : 's'}`

/**
 * The facts lane: `Deck · 14 pages · 4.2 MB`. A spreadsheet's pages are its
 * sheets; a file read with no pages counts its words; a size of zero, or
 * none, is left out.
 */
export function factsLine(row: Faceted): string {
  const type = fileType(row)
  const spread = type === 'xls' || type === 'google-sheet'
  return [
    DOCUMENT_KIND_LABELS[row.kind],
    row.pages !== null
      ? counted(row.pages, spread ? 'sheet' : 'page')
      : row.words !== null && row.words > 0
        ? counted(row.words, 'word')
        : null,
    row.sizeBytes ? formatBytes(row.sizeBytes) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

/** How much of the first line a row keeps: more than any lane shows. */
const FIRST_LINE_CHARS = 240

/**
 * The first line of a file's own text: its first line with words on it,
 * whitespace collapsed. Null when there is none.
 */
export function firstLineOf(text: string | null): string | null {
  if (text === null) return null
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    // The extractor's own `[Page 1]`, `[Slide 1]` and `[Sheet name]` lines
    // are markers, not what the file says.
    .find((l) => /[\p{L}\p{N}]/u.test(l) && !/^\[[^\]]+\]$/.test(l))
  return line === undefined ? null : line.slice(0, FIRST_LINE_CHARS)
}
