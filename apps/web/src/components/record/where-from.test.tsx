import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WhereFromMark, whereFromWords } from './where-from'

/** A filled value's where-from: the source, the day, the earlier figure. */
describe('the where-from', () => {
  const headcount = {
    source: 'Apollo',
    at: '2026-10-04T09:00:00.000Z',
    earlier: [{ value: '42', at: '2026-07-12T09:00:00.000Z' }],
  }

  it('reads as the source, the day and the earlier figure with its day', () => {
    expect(whereFromWords(headcount)).toBe('Apollo · 10-04 · was 42 on 07-12')
    expect(whereFromWords({ ...headcount, earlier: [] })).toBe('Apollo · 10-04')
  })

  it('names it on the mark beside the value', () => {
    const html = renderToStaticMarkup(
      <WhereFromMark label="Employees" from={headcount} />,
    )
    expect(html).toContain(
      'aria-label="Employees: Apollo · 10-04 · was 42 on 07-12"',
    )
    expect(html).toContain('data-where-from')
  })
})
