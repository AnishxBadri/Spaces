import { describe, expect, it } from 'vitest'
import { spacesLabel } from './enrichment-section'

/** The `is filed in` picker's trigger: several spaces, not one. */
describe('spacesLabel', () => {
  const options = [
    { id: 'a', label: 'Fintech / Payments' },
    { id: 'b', label: 'Climate' },
  ]

  it('reads any space with none chosen, the path with one, a count with more', () => {
    expect(spacesLabel([], options)).toBe('any space')
    expect(spacesLabel(['a'], options)).toBe('Fintech / Payments')
    expect(spacesLabel(['a', 'b'], options)).toBe('2 spaces')
  })

  it('counts a chosen space the picker no longer offers', () => {
    expect(spacesLabel(['gone'], options)).toBe('1 space')
  })
})
