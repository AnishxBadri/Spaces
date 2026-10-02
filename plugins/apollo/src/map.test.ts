import { describe, expect, it } from 'vitest'
import {
  apolloMessage,
  endpointUrl,
  organizationEnrichment,
  personEnrichment,
} from './map.ts'
import { fixture, fixtureNames, fixtureText } from './test-fixtures.ts'

describe('the organization mapping', () => {
  it('claims the keys and the seeded company slugs Apollo filled, and no others', () => {
    const claims = organizationEnrichment('e', fixture('organization.json'))
    expect(claims.matched).toBe(true)
    expect(claims.alias).toEqual({
      entityId: 'e',
      keys: {
        domain: 'northwind-robotics.example',
        linkedin: 'http://www.linkedin.com/company/northwind-robotics',
      },
    })
    expect(claims.facts('r')?.values).toEqual({
      description:
        'Warehouse picking robots that learn a new SKU from one demonstration.',
      founded_year: 2019,
      location: 'Pune, India',
      linkedin: 'http://www.linkedin.com/company/northwind-robotics',
    })
    expect(claims.receipt.raw).toEqual(fixture('organization.json'))
  })

  it('claims nothing the payload does not say', () => {
    const claims = organizationEnrichment('e', {
      organization: { name: 'Bare Co', founded_year: null, city: '  ' },
    })
    expect(claims.alias).toBeNull()
    expect(claims.facts('r')).toBeNull()
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

describe('the person mapping', () => {
  it('claims the email and LinkedIn as keys and the seeded person slugs as values', () => {
    const claims = personEnrichment('e', fixture('person.json'))
    expect(claims.alias?.keys).toEqual({
      email: 'meera@northwind-robotics.example',
      linkedin: 'http://www.linkedin.com/in/meera-kulkarni-robots',
    })
    expect(claims.facts('r')?.values).toEqual({
      job_title: 'Co-founder & CTO',
      location: 'Pune, India',
      linkedin: 'http://www.linkedin.com/in/meera-kulkarni-robots',
      twitter: 'https://twitter.com/meerak',
    })
  })

  it('never claims a role email or a locked one as a key', () => {
    expect(
      personEnrichment('e', fixture('person-role-email.json')).alias,
    ).toBeNull()
    expect(
      personEnrichment('e', {
        person: { email: 'email_not_unlocked@northwind-robotics.example' },
      }).alias,
    ).toBeNull()
  })

  it('reads person: null as no match', () => {
    expect(personEnrichment('e', { person: null }).matched).toBe(false)
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
