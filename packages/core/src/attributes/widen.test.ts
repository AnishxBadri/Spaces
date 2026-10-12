import { describe, expect, it } from 'vitest'
import { holdsList, widenCardinality, widenDefault, widenedType } from './widen'

describe('widen (D69)', () => {
  it('names the list shape of each single-valued type, and none for the rest', () => {
    expect(widenedType('select')).toBe('multi_select')
    expect(widenedType('record_reference')).toBe('record_reference')
    expect(widenedType('phone')).toBe('phone')
    expect(widenedType('email')).toBe('email')
    expect(widenedType('status')).toBeNull()
    expect(widenedType('number')).toBeNull()
  })

  it('reads a list from multi_select or the multi flag', () => {
    expect(holdsList({ type: 'multi_select', options: {} })).toBe(true)
    expect(holdsList({ type: 'phone', options: { multi: true } })).toBe(true)
    expect(holdsList({ type: 'select', options: {} })).toBe(false)
  })

  it('turns the target side into the N', () => {
    expect(widenCardinality('N:1')).toBe('N:N')
    expect(widenCardinality('1:1')).toBe('1:N')
    expect(widenCardinality('N:N')).toBe('N:N')
  })

  it('wraps a scalar default and leaves a list or null alone', () => {
    expect(widenDefault('seed')).toEqual(['seed'])
    expect(widenDefault(['seed'])).toEqual(['seed'])
    expect(widenDefault(null)).toBeNull()
  })
})
