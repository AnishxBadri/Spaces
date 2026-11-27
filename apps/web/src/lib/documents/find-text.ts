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
