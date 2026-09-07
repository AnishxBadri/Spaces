import { describe, expect, it } from 'vitest'
import { liveOptions, optionState } from './options'

const def = {
  options: {
    options: [
      { id: 'seed', label: 'Seed', color: 'cyan' },
      { id: 'angel', label: 'Angel', color: 'lime', archived: true },
      { id: 'series_a', label: 'Series A' },
    ],
  },
}

describe('optionState', () => {
  it('resolves a live option with its palette position', () => {
    expect(optionState(def, 'series_a')).toMatchObject({
      label: 'Series A',
      index: 2,
      archived: false,
    })
  })

  it('still resolves an archived option — it never vanishes', () => {
    expect(optionState(def, 'angel')).toMatchObject({
      label: 'Angel',
      index: 1,
      archived: true,
    })
  })

  it('falls back to the raw id for an unknown value', () => {
    expect(optionState(def, 'ipo')).toMatchObject({
      option: undefined,
      label: 'ipo',
      index: 0,
      archived: false,
    })
    expect(optionState({ options: null }, null).label).toBe('')
  })
})

describe('liveOptions', () => {
  it('drops archived options, keeps order', () => {
    expect(liveOptions(def).map((o) => o.id)).toEqual(['seed', 'series_a'])
    expect(liveOptions({ options: null })).toEqual([])
  })
})
