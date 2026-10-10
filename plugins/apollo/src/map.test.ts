import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@spaces/sdk'
import {
  CREDITS_PER_MATCH,
  PHONE_CREDITS,
  apolloMessage,
  endpointUrl,
  organizationEnrichment,
  personEnrichment,
} from './map.ts'
import { fixture, fixtureNames, fixtureText } from './test-fixtures.ts'

/** Pure: Apollo's JSON in, port arguments out — no database, no ports. */

const answersOf = (claims: ReturnType<typeof organizationEnrichment>) =>
  claims.answer('r')?.answers ?? {}

describe('the organization mapping', () => {
  it('answers every company key D76 lists in the vocabulary, the domain as identity', () => {
    const claims = organizationEnrichment('e', fixture('organization.json'))
    expect(claims.matched).toBe(true)
    expect(claims.alias).toEqual({
      entityId: 'e',
      keys: { domain: 'northwind-robotics.example' },
    })
    expect(answersOf(claims)).toEqual({
      'company.description':
        'Warehouse picking robots that learn a new SKU from one demonstration.',
      'company.founded_year': 2019,
      'company.location': 'Pune, India',
      'company.linkedin': 'http://www.linkedin.com/company/northwind-robotics',
      'company.funding_stage': 'Series A',
      'company.total_raised': 6500000,
      'company.headcount': 84,
      'company.industry': 'machinery',
      'company.keywords': [
        'robotics',
        'warehouse automation',
        'computer vision',
      ],
      'company.tech_stack': ['Amazon Web Services', 'Google Analytics'],
      'company.twitter': 'https://twitter.com/northwindbots',
      'company.address': 'Baner, Pune, Maharashtra, India',
    })
    expect(claims.receipt).toEqual({
      entityId: 'e',
      raw: fixture('organization.json'),
      creditsUsed: CREDITS_PER_MATCH,
    })
  })

  it('reads none of what D76 leaves out, and keeps Apollo’s ids in the receipt only', () => {
    const claims = organizationEnrichment('e', fixture('organization.json'))
    const said = JSON.stringify(answersOf(claims))
    for (const unused of [
      '64b7f0c2a1e3d900015a2b3c',
      '5567cd4773696439dd350000',
      '"engineering"',
      'retail',
      'alexa',
    ])
      expect(said).not.toContain(unused)
    expect(JSON.stringify(claims.receipt.raw)).toContain(
      '64b7f0c2a1e3d900015a2b3c',
    )
  })

  it('falls back to the SEO description, and answers the rest of the keys Apollo can fill', () => {
    const claims = organizationEnrichment('e', {
      organization: {
        name: 'Flent',
        primary_domain: 'flent.example',
        seo_description: 'Rental homes, furnished.',
        annual_revenue: 1200000,
        facebook_url: 'https://facebook.com/flent',
        angellist_url: 'https://angel.co/company/flent',
        crunchbase_url: 'https://www.crunchbase.com/organization/flent',
        blog_url: 'https://flent.example/blog',
        primary_phone: { sanitized_number: '+918012345678' },
        publicly_traded_symbol: 'FLNT',
        logo_url: 'https://logos.example/flent.png',
      },
    })
    expect(answersOf(claims)).toEqual({
      'company.description': 'Rental homes, furnished.',
      'company.revenue': 1200000,
      'company.facebook': 'https://facebook.com/flent',
      'company.angellist': 'https://angel.co/company/flent',
      'company.crunchbase': 'https://www.crunchbase.com/organization/flent',
      'company.blog': 'https://flent.example/blog',
      'company.phone': '+918012345678',
      'company.ticker': 'FLNT',
      'company.logo': 'https://logos.example/flent.png',
    })
  })

  it('leaves a value the vocabulary would refuse in the receipt rather than failing the answer', () => {
    const claims = organizationEnrichment('e', {
      organization: {
        twitter_url: 'twitter.com/no-scheme',
        founded_year: 2020,
      },
    })
    expect(answersOf(claims)).toEqual({ 'company.founded_year': 2020 })
  })

  it('claims nothing the payload does not say', () => {
    const claims = organizationEnrichment('e', {
      organization: { name: 'Bare Co', founded_year: null, city: '  ' },
    })
    expect(claims.alias).toBeNull()
    expect(claims.answer('r')).toBeNull()
    expect(claims.signals('r')).toEqual([])
  })

  it('reads an empty answer as no match, costing nothing', () => {
    const claims = organizationEnrichment(
      'e',
      fixture('organization-not-found.json'),
    )
    expect(claims.matched).toBe(false)
    expect(claims.receipt.creditsUsed).toBe(0)
  })

  it('refuses a body that is not an organization response', () => {
    expect(() => organizationEnrichment('e', [])).toThrow()
  })
})

describe('the latest round', () => {
  it('is one funding signal, dated, keyed on the round and its day', () => {
    const claims = organizationEnrichment('e', fixture('organization.json'))
    expect(claims.signals('r')).toEqual([
      {
        _tag: 'signal',
        entityId: 'e',
        kind: 'funding',
        title: 'Series A · $5M',
        url: 'https://news.example/northwind-robotics-series-a',
        publishedAt: '2024-03-01T00:00:00.000Z',
        payload: {
          round: 'Series A',
          amount: '5M',
          currency: '$',
          investors: 'Blume Ventures, Kae Capital',
          apolloEventId: '6612a0b1c2d3e40001f0a1b2',
        },
        receiptId: 'r',
        key: 'funding:Series A:2024-03-01',
      },
    ])
  })

  it('keys the same round the same on every run, and a new round differently', () => {
    const once = organizationEnrichment('e', fixture('organization.json'))
    const again = organizationEnrichment('e', fixture('organization.json'))
    expect(again.signals('r2').map((s) => s.key)).toEqual(
      once.signals('r1').map((s) => s.key),
    )
    const later = organizationEnrichment('e', {
      organization: {
        latest_funding_stage: 'Series B',
        latest_funding_round_date: '2026-05-10',
      },
    })
    expect(later.signals('r').map((s) => s.key)).toEqual([
      'funding:Series B:2026-05-10',
    ])
  })
})

describe('the person mapping', () => {
  it('claims the verified email and answers every person key D76 lists', () => {
    const claims = personEnrichment('e', fixture('person.json'))
    expect(claims.alias?.keys).toEqual({
      email: 'meera@northwind-robotics.example',
    })
    expect(answersOf(claims)).toEqual({
      'person.title': 'Co-founder & CTO',
      'person.description': 'Co-founder & CTO at Northwind Robotics',
      'person.location': 'Pune, India',
      'person.linkedin': 'http://www.linkedin.com/in/meera-kulkarni-robots',
      'person.twitter': 'https://twitter.com/meerak',
      'person.company': {
        name: 'Northwind Robotics',
        domain: 'northwind-robotics.example',
      },
      'person.seniority': 'C-suite',
      'person.department': 'Engineering technical',
    })
    expect(claims.receipt.creditsUsed).toBe(CREDITS_PER_MATCH)
  })

  it('answers the description from the headline only while the record has none', () => {
    const held = {
      title: null,
      description: 'Built the first picker.',
      companies: [],
    }
    const claims = personEnrichment('e', fixture('person.json'), held)
    expect(answersOf(claims)).not.toHaveProperty('person.description')
  })

  it.each([
    ['unverified', 'person-unverified.json'],
    ['a role address', 'person-role-email.json'],
    ['locked', 'person-locked.json'],
  ])('never claims an email that is %s as identity', (_why, name) => {
    expect(personEnrichment('e', fixture(name)).alias).toBeNull()
  })

  it('answers no phone unless the setting is on, and the phone costs extra credits', () => {
    const off = personEnrichment('e', fixture('person-keyhold.json'))
    expect(answersOf(off)).not.toHaveProperty('person.phone')
    expect(off.receipt.creditsUsed).toBe(CREDITS_PER_MATCH)

    const on = personEnrichment(
      'e',
      fixture('person-keyhold.json'),
      undefined,
      { phone: true },
    )
    expect(answersOf(on)['person.phone']).toBe('+919845012345')
    expect(on.receipt.creditsUsed).toBe(CREDITS_PER_MATCH + PHONE_CREDITS)
  })

  it('answers the photo, GitHub and the company by name and domain, never as a record', () => {
    const claims = personEnrichment('e', fixture('person-keyhold.json'))
    expect(answersOf(claims)).toMatchObject({
      'person.company': { name: 'Keyhold', domain: 'keyhold.example' },
      'person.photo': 'https://images.example/rohan-mehta.jpg',
      'person.github': 'https://github.com/rohan-ops',
    })
  })

  it('reads person: null as no match', () => {
    const claims = personEnrichment('e', { person: null })
    expect(claims.matched).toBe(false)
    expect(claims.receipt.creditsUsed).toBe(0)
  })
})

describe('a change of role', () => {
  const keyhold = (): JsonValue => fixture('person-keyhold.json')

  it('is nothing when nothing was held, or the same role is', () => {
    expect(personEnrichment('e', keyhold()).signals('r')).toEqual([])
    expect(
      personEnrichment('e', keyhold(), {
        title: 'COO',
        description: null,
        companies: [{ name: 'Keyhold', domains: ['keyhold.example'] }],
      }).signals('r'),
    ).toEqual([])
  })

  it('logs a changed company as one move, dated by the new role, keyed on it', () => {
    const signals = personEnrichment('e', keyhold(), {
      title: 'Head of Operations',
      description: null,
      companies: [
        { name: 'Northwind Robotics', domains: ['northwind-robotics.example'] },
      ],
    }).signals('r')
    expect(signals).toEqual([
      {
        _tag: 'signal',
        entityId: 'e',
        kind: 'hiring',
        title: 'Moved from Northwind Robotics to Keyhold as COO',
        payload: {
          from: 'Northwind Robotics',
          to: 'Keyhold',
          title: 'COO',
          previousTitle: 'Head of Operations',
        },
        publishedAt: '2025-04-01T00:00:00.000Z',
        receiptId: 'r',
        key: 'role:keyhold.example:COO',
      },
    ])
  })

  it('logs a changed title at the same company, keyed the same on a re-run', () => {
    const held = {
      title: 'VP Operations',
      description: null,
      companies: [{ name: 'Keyhold', domains: ['keyhold.example'] }],
    }
    const first = personEnrichment('e', keyhold(), held).signals('r1')
    expect(first.map((s) => s.title)).toEqual(['Now COO at Keyhold'])
    expect(
      personEnrichment('e', keyhold(), held)
        .signals('r2')
        .map((s) => s.key),
    ).toEqual(first.map((s) => s.key))
  })
})

describe('requests and errors', () => {
  it('puts the lookup in the query string, never the key', () => {
    expect(endpointUrl('people/match', { email: 'a+b@x.example' })).toBe(
      'https://api.apollo.io/api/v1/people/match?email=a%2Bb%40x.example',
    )
  })

  it('reads Apollo’s own sentence from an error body', () => {
    expect(apolloMessage('{"error":"Invalid access credentials."}')).toBe(
      'Invalid access credentials.',
    )
    expect(apolloMessage('{"message":"Not found"}')).toBe('Not found')
    expect(apolloMessage('{"errors":["a","b"]}')).toBe('a; b')
    expect(apolloMessage('<html>Bad gateway</html>')).toBe(
      '<html>Bad gateway</html>',
    )
    expect(apolloMessage('')).toBe('(no message)')
  })
})

describe('the fixtures', () => {
  const KEYISH = /api_?key|token|secret|password|authorization/i

  it.each(fixtureNames())('%s carries no key material', (name) => {
    const names: Array<string> = []
    JSON.parse(fixtureText(name), (key: string, value: unknown) => {
      names.push(key)
      return value
    })
    expect(names.filter((k) => KEYISH.test(k))).toEqual([])
    expect(fixtureText(name)).not.toMatch(/x-api-key/i)
  })
})
