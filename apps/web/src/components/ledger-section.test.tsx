import { readFileSync } from 'node:fs'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClockProvider } from '#/components/clock'
import { Day } from './ledger-section'

/**
 * The day lane: one component every dated row ends on, wide enough for a
 * day from another year and never wrapped onto a second line.
 */

const NOW = '2026-10-28T09:00:00.000Z'

const render = (node: ReactNode) =>
  renderToStaticMarkup(<ClockProvider now={NOW}>{node}</ClockProvider>)

/** The class list of the one `<time>` in `html`. */
function laneClasses(html: string): Array<string> {
  const m = /<time[^>]*class="([^"]*)"/.exec(html)
  if (m === null) throw new Error('no day lane')
  return m[1].split(' ')
}

describe('Day', () => {
  it('prints a day from another year whole, on one line', () => {
    const html = render(<Day at="2024-10-04" />)
    expect(html).toContain('>4 Oct 2024</time>')
    expect(html).toContain('dateTime="2024-10-04"')
    expect(laneClasses(html)).toEqual(
      expect.arrayContaining(['w-22', 'shrink-0', 'whitespace-nowrap', 'mono']),
    )
  })

  it("prints this year's day short, and today's row at its time with `when`", () => {
    expect(render(<Day at="2026-10-13" />)).toContain('>13 Oct</time>')
    expect(render(<Day at="2026-10-28T08:42:00.000Z" when />)).toMatch(
      />\d{2}:\d{2}<\/time>/,
    )
  })

  it('is the lane at every site that prints a row’s day', () => {
    // Each of these drew its own 72px lane, which wrapped `4 Oct 2024`.
    for (const file of [
      './record-timeline.tsx',
      './record/record-notes.tsx',
      './record/thread-row.tsx',
      './record/record-overview.tsx',
      './space-overview.tsx',
    ]) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src, file).toMatch(/<Day at=/)
      expect(src, file).not.toMatch(/w-18 shrink-0 text-right mono text-micro/)
    }
  })
})
