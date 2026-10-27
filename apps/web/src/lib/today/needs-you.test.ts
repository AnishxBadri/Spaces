import { describe, expect, it } from 'vitest'
import {
  byUrgency,
  dealsPastMedian,
  dueFigure,
  folded,
  FOLD_MIN_HIDDEN,
  foldSummary,
  inFilter,
  NEEDS_YOU_FOLD,
  todayFoldStamp,
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
      '2 more · 2 meetings',
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

describe('filters', () => {
  const rows = Array.from({ length: 11 }, (_, i) =>
    row(i % 2 === 0 ? 'task' : 'review', `k${i}`, i),
  )

  it('a kind filters to its kind; all keeps every row', () => {
    expect(inFilter(rows, 'task').every((r) => r.kind === 'task')).toBe(true)
    expect(inFilter(rows, 'task')).toHaveLength(6)
    expect(inFilter(rows, 'all')).toHaveLength(11)
    expect(inFilter(rows, 'mark')).toEqual([])
  })

  it('a readout keeps the rows its figure counted', () => {
    const mixed = [
      { ...row('task', 'late', 2), late: true },
      { ...row('task', 'due', 0), late: false },
      row('deal', 'd', 5),
      row('mark', 'm', 200),
      row('review', 'r', 1),
    ]
    expect(inFilter(mixed, 'overdue').map((r) => r.key)).toEqual(['late'])
    expect(inFilter(mixed, 'pastMedian').map((r) => r.key)).toEqual(['d'])
    expect(inFilter(mixed, 'oldestMark').map((r) => r.key)).toEqual(['m'])
  })
})

describe('the fold', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => row('task', `k${i}`, i))

  it('shows eight and folds the rest once three or more would hide', () => {
    expect(NEEDS_YOU_FOLD).toBe(8)
    expect(FOLD_MIN_HIDDEN).toBe(3)
    expect(folded(rows(11), false)).toHaveLength(8)
    expect(folded(rows(20), false)).toHaveLength(8)
  })

  it('never folds away one or two rows: it shows them', () => {
    expect(folded(rows(8), false)).toHaveLength(8)
    expect(folded(rows(9), false)).toHaveLength(9)
    expect(folded(rows(10), false)).toHaveLength(10)
  })

  it('shows every row once opened', () => {
    expect(folded(rows(11), true)).toHaveLength(11)
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
    // Past its median but not idle: the readout and the rows both leave it out.
    { id: 'g', name: 'G', stage: 'screening', days: 15 },
  ]

  it('needs both: past 21 days and past the median, in an active stage', () => {
    expect(dealsPastMedian(deals, medians, active).map((d) => d.id)).toEqual([
      'a',
      'd',
    ])
  })

  it('a stage with no median is past it on days alone', () => {
    const lone = [{ id: 'x', name: 'X', stage: 'sourcing', days: 22 }]
    expect(
      dealsPastMedian(lone, {}, new Set(['sourcing'])).map((d) => d.id),
    ).toEqual(['x'])
  })

  it('hands back the rows it was given, owner and all', () => {
    const owned = [{ ...deals[0], owner: 'Priya Raman' }]
    expect(dealsPastMedian(owned, medians, active).at(0)?.owner).toBe(
      'Priya Raman',
    )
  })
})

describe('dueFigure', () => {
  it('prints days late, or Today', () => {
    expect(dueFigure('2026-10-13', '2026-10-15')).toBe('−2d')
    expect(dueFigure('2026-10-15', '2026-10-15')).toBe('Today')
  })
})

describe('todayStamp', () => {
  it('prints weekday, month-day and ISO week', () => {
    expect(todayStamp('2026-10-09')).toBe('Fri 9 Oct · W41')
    expect(todayStamp('2026-01-01')).toBe('Thu 1 Jan · W1')
  })

  it('folds to the weekday and the day', () => {
    expect(todayFoldStamp('2026-10-15')).toBe('Thu 15 Oct')
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
    expect(foldSummary(hidden)).toBe('6 more · 3 tasks · 2 review · 1 deal')
    expect(foldSummary([row('mark', 'm', 1)])).toBe('1 more · 1 mark')
  })
})
