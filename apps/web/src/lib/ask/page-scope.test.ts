import { describe, expect, it } from 'vitest'
import { pageScope } from './page-scope'
import { byDay, outcomeWords } from './thread-list'
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

  it('names the outcome: cards applied, saved as note', () => {
    expect(outcomeWords(row('x', { applied: 2, saved: 1 }))).toBe(
      '2 applied · saved as note',
    )
    expect(outcomeWords(row('x'))).toBe('')
  })
})
