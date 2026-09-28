import { describe, expect, it } from 'vitest'
import {
  domainHost,
  isRoleEmail,
  normalizeCin,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedin,
  normalizeName,
  normalizePhone,
  normalizeUrl,
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

describe('normalizeUrl', () => {
  it('keeps an absolute http(s) URL and gives a bare host https', () => {
    expect(normalizeUrl('https://acme.com/about?x=1')).toBe(
      'https://acme.com/about?x=1',
    )
    expect(normalizeUrl('  acme.com/pricing ')).toBe('https://acme.com/pricing')
    expect(normalizeUrl('HTTP://Acme.com')).toBe('http://acme.com/')
  })
  it('rejects other schemes, whitespace and dotless hosts', () => {
    expect(normalizeUrl('ftp://acme.com')).toBeNull()
    expect(normalizeUrl('mailto:a@acme.com')).toBeNull()
    expect(normalizeUrl('acme dot com')).toBeNull()
    expect(normalizeUrl('localhost')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
  })
})

describe('normalizePhone', () => {
  it('reduces typed punctuation to + and digits', () => {
    expect(normalizePhone('+91 98450 11223')).toBe('+919845011223')
    expect(normalizePhone('(415) 555-0134')).toBe('4155550134')
  })
  it('rejects letters and implausible lengths', () => {
    expect(normalizePhone('call me')).toBeNull()
    expect(normalizePhone('12345')).toBeNull()
    expect(normalizePhone('1234567890123456')).toBeNull()
    expect(normalizePhone('555-0134 ext 2')).toBeNull()
  })
})

describe('domainHost', () => {
  it('is the host normalizeUrl reads, lowercase, without www', () => {
    expect(domainHost('https://www.Example.com/')).toBe('example.com')
    expect(domainHost('www.northgate.io/')).toBe('northgate.io')
    expect(domainHost('app.deel.com/login')).toBe('app.deel.com')
    expect(domainHost('acme.com')).toBe('acme.com')
  })
  it('is null where there is no web host', () => {
    expect(domainHost('a@acme.com')).toBeNull()
    expect(domainHost('not a domain')).toBeNull()
  })
})
