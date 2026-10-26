import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClockProvider } from '#/components/clock'
import { WhereFromMark, whereFromWords } from './where-from'

/** A filled value's where-from: the source, the day, the earlier figure. */
const TODAY = '2026-10-26'

describe('the where-from', () => {
  const headcount = {
    source: 'Apollo',
    at: '2026-10-04T09:00:00.000Z',
    earlier: [{ value: '42', at: '2026-07-12T09:00:00.000Z' }],
  }

  it('reads as the source, the day and the earlier figure with its day', () => {
    expect(whereFromWords(headcount, TODAY)).toBe(
      'Apollo · 4 Oct · was 42 on 12 Jul',
    )
    expect(whereFromWords({ ...headcount, earlier: [] }, TODAY)).toBe(
      'Apollo · 4 Oct',
    )
    expect(whereFromWords(headcount, '2027-01-02')).toBe(
      'Apollo · 4 Oct 2026 · was 42 on 12 Jul 2026',
    )
  })

  it('names it on the mark beside the value', () => {
    const html = renderToStaticMarkup(
      <ClockProvider now={`${TODAY}T12:00:00.000Z`}>
        <WhereFromMark label="Employees" from={headcount} />
      </ClockProvider>,
    )
    expect(html).toContain(
      'aria-label="Employees: Apollo · 4 Oct · was 42 on 12 Jul"',
    )
    expect(html).toContain('data-where-from')
  })
})
