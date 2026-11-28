import { describe, expect, it } from 'vitest'
import { byWeek, upcomingSplit, weekBand } from './weeks'

// A Friday, so the week runs Monday 21st to Sunday 27th.
const TODAY = '2026-09-25'
const NOW = '2026-09-25T10:00:00.000Z'

describe('weekBand', () => {
  it('never puts a row ahead of today in This week', () => {
    for (const at of ['2026-09-26', '2026-09-27', '2026-10-20T14:00:00Z']) {
      expect(weekBand(at, TODAY)).not.toBe('This week')
      expect(weekBand(at, TODAY)).toBe('Upcoming')
    }
    expect(weekBand('2026-09-25', TODAY)).toBe('This week')
    expect(weekBand('2026-09-21', TODAY)).toBe('This week')
    expect(weekBand('2026-09-20', TODAY)).toBe('Last week')
    expect(weekBand('2026-09-10', TODAY)).toBe('Earlier')
  })

  it('keeps a row ahead of today out of the week bands', () => {
    const bands = byWeek(
      [{ at: '2026-10-20T14:00:00Z' }, { at: '2026-09-24T09:00:00Z' }],
      TODAY,
    )
    expect(bands.map((b) => [b.band, b.rows.length])).toEqual([
      ['Upcoming', 1],
      ['This week', 1],
    ])
  })
})

describe('upcomingSplit', () => {
  const row = (id: string, at: string) => ({ id, at })

  it('takes what is ahead of now, earliest first, three before the fold', () => {
    const rows = [
      row('nov', '2026-11-04T11:00:00.000Z'),
      row('oct27', '2026-10-27T10:00:00.000Z'),
      row('later-today', '2026-09-25T16:00:00.000Z'),
      row('morning', '2026-09-25T08:00:00.000Z'),
      row('dec', '2026-12-01T09:00:00.000Z'),
      row('oct20', '2026-10-20T14:00:00.000Z'),
      row('last-week', '2026-09-18T09:00:00.000Z'),
    ]
    const split = upcomingSplit(rows, NOW)
    expect(split.shown.map((r) => r.id)).toEqual([
      'later-today',
      'oct20',
      'oct27',
    ])
    expect(split.folded.map((r) => r.id)).toEqual(['nov', 'dec'])
    // What has happened keeps its order, this morning's meeting included.
    expect(split.past.map((r) => r.id)).toEqual(['morning', 'last-week'])
  })

  it('folds nothing with three or fewer ahead, and holds none with none', () => {
    const three = upcomingSplit(
      [
        row('a', '2026-10-01T09:00:00.000Z'),
        row('b', '2026-09-30T09:00:00.000Z'),
        row('c', '2026-10-02T09:00:00.000Z'),
      ],
      NOW,
    )
    expect(three.shown.map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(three.folded).toEqual([])
    const none = upcomingSplit([row('x', '2026-09-20T09:00:00.000Z')], NOW)
    expect(none.shown).toEqual([])
    expect(none.folded).toEqual([])
    expect(none.past.map((r) => r.id)).toEqual(['x'])
  })
})
