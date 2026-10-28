import { describe, expect, it } from 'vitest'
import { pageScope } from './page-scope'
import { byDay, dayBand, outcomeWords } from './thread-list'
import type { AskThreadRow } from './types'

const ID = '00000000-0000-4000-8000-000000000001'

describe('pageScope', () => {
  it('is the record or space the page is on, named by the page', () => {
    expect(pageScope(`/deals/${ID}`, 'Acme Series A')).toEqual({
      kind: 'record',
      id: ID,
      name: 'Acme Series A',
      href: `/deals/${ID}`,
    })
    expect(pageScope(`/spaces/${ID}`, 'Hydrogen')?.kind).toBe('space')
    expect(pageScope(`/people/${ID}`, 'Priya')?.kind).toBe('person')
    expect(pageScope(`/o/funds/${ID}`, 'Fund II')?.href).toBe(`/o/funds/${ID}`)
  })

  it('is nothing on a page with no subject', () => {
    expect(pageScope('/today', null)).toBeNull()
    expect(pageScope('/companies', 'x')).toBeNull()
  })
})

describe('the thread list', () => {
  const row = (createdAt: string, extra: Partial<AskThreadRow> = {}) => ({
    id: createdAt,
    title: 't',
    createdAt,
    scope: [],
    questions: 1,
    applied: 0,
    saved: 0,
    ...extra,
  })

  it('groups threads by local day, newest first as given', () => {
    const groups = byDay([
      row('2026-10-12T15:00:00'),
      row('2026-10-12T09:00:00'),
      row('2026-10-10T09:00:00'),
    ])
    expect(groups.map((g) => [g.day, g.rows.length])).toEqual([
      ['2026-10-12', 2],
      ['2026-10-10', 1],
    ])
  })

  it('names the outcome in sentence case: cards applied, saved as note', () => {
    expect(outcomeWords(row('x', { applied: 2, saved: 1 }))).toBe(
      '2 applied · Saved as note',
    )
    expect(outcomeWords(row('x', { saved: 2 }))).toBe('Saved as 2 notes')
    expect(outcomeWords(row('x'))).toBe('')
  })

  it('heads a day band TODAY, else its day in caps', () => {
    expect(dayBand('2026-10-12', '2026-10-12')).toBe('TODAY')
    expect(dayBand('2026-10-09', '2026-10-12')).toBe('9 OCT')
    expect(dayBand('2025-10-09', '2026-10-12')).toBe('9 OCT 2025')
  })
})
