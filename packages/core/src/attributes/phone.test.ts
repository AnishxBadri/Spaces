import { describe, expect, it } from 'vitest'
import {
  CALLING_CODES,
  callingCodesFor,
  formatPhone,
  withCallingCode,
} from './phone'

/** The phone editor's country picker: the ITU list, offered until a code is in. */
describe('CALLING_CODES', () => {
  it('agrees with formatPhone on every code length, so a picked code groups right', () => {
    for (const { code, country } of CALLING_CODES)
      expect(formatPhone(`+${code}5550100`), country).toMatch(
        new RegExp(`^\\+${code} `),
      )
  })

  it('is sorted by country name with no country twice', () => {
    const names = CALLING_CODES.map((c) => c.country)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')))
  })
})

describe('callingCodesFor', () => {
  const codes = (draft: string) => callingCodesFor(draft).map((c) => c.code)

  it('offers every code on an empty field or a number without its +', () => {
    expect(callingCodesFor('')).toBe(CALLING_CODES)
    expect(callingCodesFor('415 555 0100')).toBe(CALLING_CODES)
  })

  it('narrows to the codes a + prefix could become', () => {
    expect(new Set(codes('+4'))).toEqual(
      new Set([
        '40',
        '41',
        '43',
        '44',
        '45',
        '46',
        '47',
        '48',
        '49',
        '420',
        '421',
        '423',
      ]),
    )
    expect(new Set(codes('+44'))).toEqual(new Set(['44']))
  })

  it('finds a country by name', () => {
    expect(callingCodesFor('kingd')).toEqual([
      { code: '44', country: 'United Kingdom' },
    ])
  })

  it('offers nothing once the code is in and the number begun', () => {
    expect(codes('+447')).toEqual([])
    expect(codes('+44 ')).toEqual([])
    expect(codes('+14155550100')).toEqual([])
  })
})

describe('withCallingCode', () => {
  it('puts the code in front, keeping a typed national number', () => {
    expect(withCallingCode('', '44')).toBe('+44 ')
    expect(withCallingCode('United', '44')).toBe('+44 ')
    expect(withCallingCode('20 7946 0958', '44')).toBe('+44 20 7946 0958')
  })
})
