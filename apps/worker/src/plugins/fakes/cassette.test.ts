import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCassette } from './cassette'
import { REPO_PLUGINS } from './enrichers'
import { makeFakeProvider } from './provider'
import { cassetteProviders, fakeKeyFor } from './registry'

/**
 * The cassette and the provider fake on their own: Apollo's committed
 * cassette answers by method and URL, exact before wildcard; the fake's
 * state (a revoked key, a 429, a failing URL) answers before it; and the
 * registry finds a cassette only where a plugin committed one.
 */

const APOLLO_FIXTURES = path.join(REPO_PLUGINS, 'apollo', 'fixtures')
const ORG = 'https://api.apollo.io/api/v1/organizations/enrich'
const PERSON = 'https://api.apollo.io/api/v1/people/match'

const apollo = () => loadCassette(APOLLO_FIXTURES)

const bodyOf = (recorded: { readonly body: string } | null): unknown =>
  recorded === null ? null : JSON.parse(recorded.body)

const send = (
  fake: ReturnType<typeof makeFakeProvider>,
  url: string,
  key = 'k-1',
) =>
  fake.fetch(url, {
    method: 'POST',
    headers: { 'X-Api-Key': key },
  })

describe('the Apollo cassette', () => {
  it('answers a recorded URL with its recorded file', () => {
    expect(
      bodyOf(
        apollo().match('POST', `${ORG}?domain=northwind-robotics.example`),
      ),
    ).toMatchObject({
      organization: {
        name: 'Northwind Robotics',
        primary_domain: 'northwind-robotics.example',
      },
    })
    expect(
      bodyOf(apollo().match('POST', `${ORG}?domain=no-such-company.example`)),
    ).toEqual({})
  })

  it('answers any other domain from the wildcard, the domain spliced in', () => {
    expect(
      bodyOf(apollo().match('POST', `${ORG}?domain=acme-tools.example`)),
    ).toMatchObject({
      organization: {
        primary_domain: 'acme-tools.example',
        website_url: 'http://www.acme-tools.example',
        city: 'Berlin',
      },
    })
  })

  it('decodes the query before matching and escapes what it splices', () => {
    expect(
      bodyOf(
        apollo().match(
          'POST',
          `${PERSON}?email=meera%40northwind-robotics.example`,
        ),
      ),
    ).toMatchObject({ person: { title: 'Co-founder & CTO' } })
    expect(
      bodyOf(apollo().match('POST', `${PERSON}?email=a%22b%40c.example`)),
    ).toMatchObject({ person: { email: 'a"b@c.example' } })
  })

  it('matches nothing on another method, path or query shape', () => {
    const cassette = apollo()
    expect(cassette.match('GET', `${ORG}?domain=x.example`)).toBeNull()
    expect(
      cassette.match('POST', 'https://api.apollo.io/api/v1/elsewhere'),
    ).toBeNull()
    expect(cassette.match('POST', `${ORG}?domain=x.example&extra=1`)).toBeNull()
  })

  it('records what Apollo answers a revoked key', () => {
    expect(apollo().revoked.status).toBe(401)
    expect(bodyOf(apollo().revoked)).toMatchObject({
      error: 'Invalid access credentials.',
    })
  })

  it('refuses a cassette naming a file that is not there', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spaces-cassette-'))
    mkdirSync(path.join(dir, 'cassette'))
    writeFileSync(
      path.join(dir, 'cassette', 'cassette.json'),
      JSON.stringify({
        keyHeader: 'x-key',
        interactions: [
          {
            method: 'GET',
            url: 'https://x.example/',
            status: 200,
            file: 'missing.json',
          },
        ],
      }),
    )
    expect(() => loadCassette(dir)).toThrow(/missing\.json/)
  })
})

describe('the provider fake', () => {
  it('records each request with the key from the cassette’s header', async () => {
    const fake = makeFakeProvider(apollo())
    const res = await send(fake, `${ORG}?domain=northwind-robotics.example`)
    expect(res.status).toBe(200)
    expect(fake.requests.map((r) => [r.method, r.key])).toEqual([
      ['POST', 'k-1'],
    ])
  })

  it('answers 429 with Retry-After as many times as it was told, then the cassette', async () => {
    const fake = makeFakeProvider(apollo())
    fake.rateLimit(1, '2')
    const url = `${ORG}?domain=northwind-robotics.example`
    const limited = await send(fake, url)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('2')
    expect((await send(fake, url)).status).toBe(200)
  })

  it('answers a revoked key with the cassette’s revocation, and other keys as before', async () => {
    const fake = makeFakeProvider(apollo())
    fake.revoke('k-1')
    const url = `${ORG}?domain=northwind-robotics.example`
    const refused = await send(fake, url, 'k-1')
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({
      error: 'Invalid access credentials.',
    })
    expect((await send(fake, url, 'k-2')).status).toBe(200)
  })

  it('fails the URLs it was told to fail and answers the rest', async () => {
    const fake = makeFakeProvider(apollo())
    fake.failWhere((url) => url.includes('broken.example'), 503)
    expect((await send(fake, `${ORG}?domain=broken.example`)).status).toBe(503)
    expect((await send(fake, `${ORG}?domain=fine.example`)).status).toBe(200)
  })

  it('answers an unrecorded request 404, naming it', async () => {
    const fake = makeFakeProvider(apollo())
    const res = await send(fake, 'https://api.apollo.io/api/v1/unknown')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain(
      'no recorded interaction for POST https://api.apollo.io/api/v1/unknown',
    )
  })
})

describe('cassetteProviders', () => {
  it('stands in for a plugin that committed a cassette, with a key that is not one', () => {
    const fakes = cassetteProviders()
    expect(fakes.standIn('apollo')).toMatchObject({
      secret: fakeKeyFor('apollo'),
    })
    // One fake per plugin per process: its state is shared by every job.
    expect(fakes.provider('apollo')).toBe(fakes.provider('apollo'))
  })

  it('stands in for nothing else, and for nothing outside a workspace', () => {
    expect(cassetteProviders().standIn('rss')).toBeNull()
    expect(cassetteProviders().standIn('../apollo')).toBeNull()
    expect(cassetteProviders(null).standIn('apollo')).toBeNull()
  })
})
