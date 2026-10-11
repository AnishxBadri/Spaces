import { describe, expect, it } from 'vitest'
import {
  byUrgency,
  dealsPastMedian,
  folded,
  foldSummary,
  idleDeals,
  inTab,
  NEEDS_YOU_FOLD,
  todayStamp,
} from './needs-you'
import type { NeedsYouKind, Ranked } from './needs-you'

const row = (kind: NeedsYouKind, key: string, weight: number): Ranked => ({
  kind,
  key,
  weight,
})

describe('byUrgency', () => {
  it('ranks a meeting nobody wrote up after tasks and before deals', () => {
    const rows = [
      row('deal', 'd', 30),
      row('meeting', 'mt-fresh', 0),
      row('task', 't', 0),
      row('meeting', 'mt-old', 3),
    ]
    expect(byUrgency(rows).map((r) => r.key)).toEqual([
      't',
      'mt-old',
      'mt-fresh',
      'd',
    ])
    expect(foldSummary([row('meeting', 'a', 1), row('meeting', 'b', 2)])).toBe(
      '+ 2 more · 2 meetings',
    )
  })

  it('orders tasks, then deals, then marks, then review groups, each largest first', () => {
    const rows = [
      row('review', 'r-small', 1),
      row('mark', 'm-old', 400),
      row('task', 't-today', 0),
      row('deal', 'd-far', 30),
      row('review', 'r-big', 3),
      row('task', 't-late', 5),
      row('deal', 'd-near', 2),
      row('mark', 'm-newer', 200),
    ]
    expect(byUrgency(rows).map((r) => r.key)).toEqual([
      't-late',
      't-today',
      'd-far',
      'd-near',
      'm-old',
      'm-newer',
      'r-big',
      'r-small',
    ])
  })

  it('breaks a tie by key, so the order is stable', () => {
    const rows = [row('task', 'b', 1), row('task', 'a', 1)]
    expect(byUrgency(rows).map((r) => r.key)).toEqual(['a', 'b'])
  })
})

describe('tabs and fold', () => {
  const rows = Array.from({ length: 11 }, (_, i) =>
    row(i % 2 === 0 ? 'task' : 'review', `k${i}`, i),
  )

  it('a tab filters to its kind; all keeps every row', () => {
    expect(inTab(rows, 'task').every((r) => r.kind === 'task')).toBe(true)
    expect(inTab(rows, 'task')).toHaveLength(6)
    expect(inTab(rows, 'all')).toHaveLength(11)
    expect(inTab(rows, 'mark')).toEqual([])
  })

  it('folds at eight until opened', () => {
    expect(NEEDS_YOU_FOLD).toBe(8)
    expect(folded(rows, false)).toHaveLength(8)
    expect(folded(rows, true)).toHaveLength(11)
  })
})

describe('deal rules', () => {
  const active = new Set(['screening', 'diligence'])
  const medians = { screening: 10, diligence: 40 }
  const deals = [
    { id: 'a', name: 'A', stage: 'screening', days: 25 },
    { id: 'b', name: 'B', stage: 'screening', days: 8 },
    { id: 'c', name: 'C', stage: 'diligence', days: 30 },
    { id: 'd', name: 'D', stage: 'diligence', days: 45 },
    { id: 'e', name: 'E', stage: 'passed', days: 300 },
    { id: 'f', name: 'F', stage: 'term-sheet', days: null },
  ]

  it('past median counts every active deal longer in stage than its median', () => {
    expect(dealsPastMedian(deals, medians, active).map((d) => d.id)).toEqual([
      'a',
      'd',
    ])
  })

  it('idle needs both: past 21 days and past the median', () => {
    const more = [
      ...deals,
      { id: 'g', name: 'G', stage: 'screening', days: 15 },
    ]
    expect(idleDeals(more, medians, active).map((d) => d.id)).toEqual([
      'a',
      'd',
    ])
  })

  it('a stage with no median is idle on days alone', () => {
    const lone = [{ id: 'x', name: 'X', stage: 'sourcing', days: 22 }]
    expect(idleDeals(lone, {}, new Set(['sourcing'])).map((d) => d.id)).toEqual(
      ['x'],
    )
  })
})

describe('todayStamp', () => {
  it('prints weekday, month-day and ISO week', () => {
    expect(todayStamp('2026-10-09')).toBe('Fri 10-09 · W41')
    expect(todayStamp('2026-01-01')).toBe('Thu 01-01 · W1')
  })
})

describe('foldSummary', () => {
  it('counts what the fold hides and names each kind, sheet order', () => {
    const hidden = [
      row('deal', 'd', 1),
      row('task', 'a', 1),
      row('review', 'r1', 1),
      row('task', 'b', 1),
      row('review', 'r2', 1),
      row('task', 'c', 1),
    ]
    expect(foldSummary(hidden)).toBe('+ 6 more · 3 tasks · 2 review · 1 deal')
    expect(foldSummary([row('mark', 'm', 1)])).toBe('+ 1 more · 1 mark')
  })
})
