import type { Format } from '@spaces/core/documents/extract'

/**
 * Find in a file's stored text, pure, for the viewer's find field: the
 * server counts hits by page, and the `Text` view marks them.
 * - Pages are the `[Page N]` / `[Slide N]` / `[Sheet name]` markers the
 *   extractor writes, read the way `chunk` reads them, so a page here is the
 *   page a citation names. A marker line is never a hit.
 * - Case-insensitive; a query shorter than {@link MIN_QUERY} finds nothing,
 *   so a single letter never marks a whole file.
 */

/** The shortest query that searches. */
export const MIN_QUERY = 2

/** What a file calls its pages; null for text with none. */
export type PageUnit = 'page' | 'slide' | 'sheet'

export type FindHits = {
  readonly total: number
  /** Only pages with a hit, in reading order; one null page for text with no pages. */
  readonly pages: ReadonlyArray<{
    readonly page: number | null
    readonly hits: number
  }>
  readonly unit: PageUnit | null
}

const MARKERS: Partial<
  Record<Format, { re: RegExp; unit: PageUnit; numbered: boolean }>
> = {
  pdf: { re: /^\[Page (\d+)\]$/, unit: 'page', numbered: true },
  pptx: { re: /^\[Slide (\d+)\]$/, unit: 'slide', numbered: true },
  xlsx: { re: /^\[(.+)\]$/, unit: 'sheet', numbered: false },
}

/** The query as a global, case-insensitive pattern; null when too short. */
export function findPattern(query: string): RegExp | null {
  const q = query.trim()
  if (q.length < MIN_QUERY) return null
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
}

const count = (text: string, pattern: RegExp) =>
  text.match(new RegExp(pattern.source, pattern.flags))?.length ?? 0

export function findHits(
  text: string,
  format: Format | null,
  query: string,
): FindHits {
  const pattern = findPattern(query)
  const marker = format === null ? undefined : MARKERS[format]
  if (pattern === null) return { total: 0, pages: [], unit: null }
  if (marker === undefined) {
    const hits = count(text, pattern)
    return {
      total: hits,
      pages: hits > 0 ? [{ page: null, hits }] : [],
      unit: null,
    }
  }

  // A marker opens a page only at the start or after a blank line, the shape
  // the extractor joins pages in, so a row that reads `[x]` stays a row.
  const byPage = new Map<number | null, number>()
  let page: number | null = null
  let ordinal = 0
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const m = i === 0 || lines[i - 1] === '' ? marker.re.exec(line) : null
    if (m) {
      page = marker.numbered ? Number(m[1]) : ++ordinal
      return
    }
    const hits = count(line, pattern)
    if (hits > 0) byPage.set(page, (byPage.get(page) ?? 0) + hits)
  })
  const pages = [...byPage].map(([p, hits]) => ({ page: p, hits }))
  return {
    total: pages.reduce((n, p) => n + p.hits, 0),
    pages,
    unit: marker.unit,
  }
}

/** `4 on 3 pages`, `1 on 1 sheet`, `4 found`, `None`. */
export function hitsLine(hits: FindHits): string {
  if (hits.total === 0) return 'None'
  const paged = hits.pages.filter((p) => p.page !== null).length
  if (hits.unit === null || paged === 0) return `${hits.total} found`
  return `${hits.total} on ${paged} ${hits.unit}${paged === 1 ? '' : 's'}`
}

/** The text cut into runs, the hits flagged, for the `Text` view's marks. */
export function markRuns(
  text: string,
  query: string,
): Array<{ text: string; hit: boolean }> {
  const pattern = findPattern(query)
  if (pattern === null) return [{ text, hit: false }]
  const runs: Array<{ text: string; hit: boolean }> = []
  let at = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index), hit: false })
    runs.push({ text: m[0], hit: true })
    at = m.index + m[0].length
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false })
  return runs
}

/** A `[Page N]` or `[Slide N]` line: never a place, whatever the format. */
const MARKER_LINE = /^\[(Page|Slide) \d+\]$/

/** Characters of the line kept before the match in a snippet. */
const SNIPPET_BEFORE = 40

/** Characters of the line kept after the match; the row cuts the rest. */
const SNIPPET_AFTER = 160

/** Other pages a hit names before `…`. */
const MORE_PAGES = 3

/** A search's first match in a file, and how many more places it matched. */
export type SearchHit = {
  /** Every place it matched. */
  readonly total: number
  /** The first match's page or slide, to open the file at; null otherwise. */
  readonly page: number | null
  /** The first match's page as the row prints it: `p. 5`, a sheet's name. */
  readonly label: string | null
  /** The snippet: its line around the match. */
  readonly before: string
  readonly match: string
  readonly after: string
  /** `+3 on p. 6, 9`; null when it matched once. */
  readonly more: string | null
}

/**
 * Where the search matches a file's stored text: the first place with its
 * page and a snippet, and the rest counted, with their pages. Pages are the
 * extractor's markers, read as `findHits` reads them; a place is counted as
 * `placesSql` counts it, so the rows add up to the toolbar's `9 places`.
 * Null when the query is too short or the text holds no match.
 */
export function searchHit(
  text: string,
  format: Format | null,
  query: string,
): SearchHit | null {
  const pattern = findPattern(query)
  if (pattern === null) return null
  const marker = format === null ? undefined : MARKERS[format]

  type Place = { page: number | null; label: string | null }
  const places: Array<Place> = []
  let first: { line: string; at: number; length: number } | null = null
  let page: number | null = null
  let label: string | null = null
  let ordinal = 0
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    const m =
      marker !== undefined && (i === 0 || lines[i - 1] === '')
        ? marker.re.exec(line)
        : null
    if (m && marker !== undefined) {
      page = marker.numbered ? Number(m[1]) : ++ordinal
      label = marker.unit === 'sheet' ? m[1] : `p. ${String(page)}`
      continue
    }
    if (MARKER_LINE.test(line)) continue
    for (const found of line.matchAll(pattern)) {
      first ??= { line, at: found.index, length: found[0].length }
      places.push({ page, label })
    }
  }
  const head = places.at(0)
  if (first === null || head === undefined) return null
  const { line, at, length } = first

  let before = line.slice(Math.max(0, at - SNIPPET_BEFORE), at)
  if (at > SNIPPET_BEFORE) {
    // Start on a word, not inside one.
    const space = before.indexOf(' ')
    before = `…${space < 0 ? before : before.slice(space + 1)}`
  }
  const others: Array<string> = []
  for (const p of places.slice(1))
    if (p.label !== null && p.label !== head.label && !others.includes(p.label))
      others.push(p.label)
  const shown = others.slice(0, MORE_PAGES)
  const paged = shown.every((o) => o.startsWith('p. '))
  const named =
    shown.length === 0
      ? ''
      : ` on ${
          paged
            ? `p. ${shown.map((o) => o.slice('p. '.length)).join(', ')}`
            : shown.join(', ')
        }${others.length > MORE_PAGES ? ', …' : ''}`
  return {
    total: places.length,
    // A sheet's number is its position, which no viewer opens at.
    page: marker?.unit === 'sheet' ? null : head.page,
    label: head.label,
    before: before.replace(/\s+/g, ' ').trimStart(),
    match: line.slice(at, at + length),
    after: line
      .slice(at + length, at + length + SNIPPET_AFTER)
      .replace(/\s+/g, ' '),
    more: places.length > 1 ? `+${String(places.length - 1)}${named}` : null,
  }
}
