import { describe, expect, it } from 'vitest'
import { cn } from './utils'

/** `cn` keeps a type-scale step and a colour side by side, every step. */
describe('cn', () => {
  it.each([
    'field',
    'micro',
    'label',
    'ui',
    'body',
    'title',
    'page',
    'display',
  ])('keeps text-%s beside a colour', (step) => {
    expect(cn(`mono text-${step}`, 'text-graphite')).toBe(
      `mono text-${step} text-graphite`,
    )
  })

  it('still lets a later step replace an earlier one', () => {
    expect(cn('text-field', 'text-label')).toBe('text-label')
  })
})
