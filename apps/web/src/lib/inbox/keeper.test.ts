import { describe, expect, it } from 'vitest'
import { defaultKeeper, nonEmptyValueCount } from './keeper'
import type { KeeperSide } from './keeper'

const side = (over: Partial<KeeperSide> = {}): KeeperSide => ({
  valueCount: 0,
  spaces: [],
  mentionCount: 0,
  createdAt: '2025-01-01T00:00:00.000Z',
  ...over,
})

describe('nonEmptyValueCount', () => {
  it('counts values that hold something, and not null, blank or []', () => {
    expect(
      nonEmptyValueCount({
        domains: ['garudaautonomy.com'],
        team_size: 39,
        thesis_fit: 0,
        flag: false,
        note: '  ',
        tags: [],
        stage: null,
      }),
    ).toBe(4)
    expect(nonEmptyValueCount({})).toBe(0)
  })
})

describe('defaultKeeper', () => {
  it('keeps the Garuda record with the domain, the space and the mention', () => {
    // A: Garuda Autonomy Pvt Ltd — no values, no space, no mention, newer.
    const a = side({ createdAt: '2026-09-19T14:41:32.296Z' })
    // B: Garuda Autonomy — domain and seven more values, UAS, one mention.
    const b = side({
      valueCount: 8,
      spaces: ['UAS'],
      mentionCount: 1,
      createdAt: '2024-12-18T05:10:00.000Z',
    })
    expect(defaultKeeper(a, b)).toBe('b')
    expect(defaultKeeper(b, a)).toBe('a')
  })

  it('ranks values first, then spaces, then mentions, then the older record', () => {
    expect(
      defaultKeeper(
        side({ valueCount: 2 }),
        side({ valueCount: 1, spaces: ['x', 'y'], mentionCount: 9 }),
      ),
    ).toBe('a')
    expect(
      defaultKeeper(
        side({ valueCount: 1, spaces: ['x'] }),
        side({ valueCount: 1, spaces: ['x', 'y'], mentionCount: 0 }),
      ),
    ).toBe('b')
    expect(
      defaultKeeper(
        side({ spaces: ['x'], mentionCount: 3 }),
        side({ spaces: ['y'], mentionCount: 1 }),
      ),
    ).toBe('a')
    expect(
      defaultKeeper(
        side({ createdAt: '2026-01-01T00:00:00.000Z' }),
        side({ createdAt: '2024-01-01T00:00:00.000Z' }),
      ),
    ).toBe('b')
  })

  it('keeps A on a full tie', () => {
    expect(defaultKeeper(side(), side())).toBe('a')
  })
})
