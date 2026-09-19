import { describe, expect, it } from 'vitest'
import {
  isRoleEmail,
  normalizeCin,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
} from './normalize'

describe('normalizeDomain', () => {
  it('reduces to registrable domain', () => {
    expect(normalizeDomain('www.stripe.com')).toBe('stripe.com')
    expect(normalizeDomain('https://app.deel.com/login')).toBe('deel.com')
    expect(normalizeDomain('Docs.Google.CO.IN')).toBe('google.co.in')
  })
  it('rejects free-mail domains — never company identity', () => {
    expect(normalizeDomain('gmail.com')).toBeNull()
    expect(normalizeDomain('mail.yahoo.com')).toBeNull()
  })
  it('rejects garbage', () => {
    expect(normalizeDomain('not a domain')).toBeNull()
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
  })
})

describe('normalizeEmail', () => {
  it('lowercases everywhere', () => {
    expect(normalizeEmail('Founder@Startup.IO')).toBe('founder@startup.io')
  })
  it('gmail: strips dots and +tags, canonicalizes googlemail', () => {
    expect(normalizeEmail('an.ish+deals@gmail.com')).toBe('anish@gmail.com')
    expect(normalizeEmail('anish@googlemail.com')).toBe('anish@gmail.com')
  })
  it('non-gmail: dots stay significant', () => {
    expect(normalizeEmail('a.badri@fund.com')).toBe('a.badri@fund.com')
  })
  it('rejects invalid shapes', () => {
    expect(normalizeEmail('nope')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
  })
})

describe('isRoleEmail', () => {
  it('flags role prefixes', () => {
    expect(isRoleEmail('info@startup.io')).toBe(true)
    expect(isRoleEmail('careers@startup.io')).toBe(true)
    expect(isRoleEmail('pitch+q3@startup.io')).toBe(true)
  })
  it('passes personal addresses', () => {
    expect(isRoleEmail('anish@startup.io')).toBe(false)
  })
})

describe('normalizeName', () => {
  it('strips legal suffixes', () => {
    expect(normalizeName('Orbital Composites Inc.')).toBe('orbital composites')
    expect(normalizeName('Agnikul Cosmos Pvt Ltd')).toBe('agnikul cosmos')
    expect(normalizeName('Rocket Lab Ltd')).toBe('rocket lab')
  })
  it('strips diacritics and punctuation', () => {
    expect(normalizeName('Café Coffée Day')).toBe('cafe coffee day')
    expect(normalizeName("O'Brien & Sons")).toBe('o brien sons')
  })
})

describe('normalizeLinkedin', () => {
  it('canonicalizes profile and company URLs', () => {
    expect(
      normalizeLinkedin('https://www.linkedin.com/in/anish-badri/?src=x'),
    ).toBe('linkedin.com/in/anish-badri')
    expect(normalizeLinkedin('linkedin.com/company/SpaceX/')).toBe(
      'linkedin.com/company/spacex',
    )
  })
  it('rejects non-linkedin', () => {
    expect(normalizeLinkedin('https://twitter.com/foo')).toBeNull()
  })
})

describe('normalizeCin', () => {
  it('accepts a structurally valid CIN', () => {
    expect(normalizeCin('U72900KA2015PTC080052')).toBe('U72900KA2015PTC080052')
  })
  it('rejects malformed input', () => {
    expect(normalizeCin('12345')).toBeNull()
  })
})
