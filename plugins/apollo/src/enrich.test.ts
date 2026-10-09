import { Effect, Exit } from 'effect'
import { z } from 'zod'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import type { RecordedCall } from '@spaces/sdk/testing'
import type { EventInput, ReadEntity } from '@spaces/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobs } from './index.ts'
import { APOLLO_API, endpointUrl } from './map.ts'
import { fixture } from './test-fixtures.ts'

/**
 * Both Apollo jobs on the SDK's recording Layers, against committed
 * fixtures: no database, no network, no integration row. `fetch` is
 * replaced by one that throws, so a request that escaped the Http port
 * would fail the test rather than reach Apollo.
 */
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the Apollo tests must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/** Not a key: the Secrets port hands the job this, and nothing checks it. */
const TEST_KEY = 'test-apollo-key'

const ORG_URL = `${APOLLO_API}/organizations/enrich?domain=northwind-robotics.example`
const PERSON_URL = `${APOLLO_API}/people/match?email=meera%40northwind-robotics.example`

const company = readEntity({
  id: 'entity-0',
  name: 'Northwind',
  keys: {
    domain: ['northwind-robotics.example'],
    email: [],
    linkedin: [],
  },
})

const person = readEntity({
  id: 'entity-0',
  kind: 'person',
  name: 'Meera Kulkarni',
  keys: {
    domain: [],
    email: ['meera@northwind-robotics.example'],
    linkedin: [],
  },
})

type Job = (typeof jobs)['enrichCompany' | 'enrichPerson']

const run = (job: Job, ports: ReturnType<typeof testPorts>) =>
  Effect.runPromiseExit(
    job.run({ entityId: 'entity-0' }).pipe(Effect.provide(ports.layer)),
  )

const portsFor = (
  entity: ReadEntity,
  url: string,
  response: { readonly status?: number; readonly body: unknown },
) =>
  testPorts({
    secret: TEST_KEY,
    entities: [entity],
    // The record already holds the key it was read by.
    known: {
      [entity.id]: entity.keys.domain[0]
        ? { domain: entity.keys.domain[0] }
        : entity.keys.email[0]
          ? { email: entity.keys.email[0] }
          : {},
    },
    http: [
      {
        method: 'POST',
        url,
        response: {
          ...(response.status === undefined ? {} : { status: response.status }),
          body: JSON.stringify(response.body),
        },
      },
    ],
  })

/** The call log, with the response body (the fixture again) left out. */
const callLog = (calls: ReadonlyArray<RecordedCall>) =>
  calls.map(({ port, method, input, output }) =>
    port === 'Http'
      ? { call: `${port}.${method}`, input }
      : { call: `${port}.${method}`, input, output },
  )

const failureOf = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit) ? JSON.parse(JSON.stringify(exit.cause)) : null

describe('enrichCompany', () => {
  it('stores the receipt, adds the aliases, then fills the mapped values citing it', async () => {
    const ports = portsFor(company, ORG_URL, {
      body: fixture('organization.json'),
    })
    const exit = await run(jobs.enrichCompany, ports)
    expect(exit._tag).toBe('Success')

    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Secrets.get',
      'Http.request',
      'Receipts.store',
      'Identity.addAlias',
      'Facts.fill',
      'Content.emitSignal',
      'Log.info',
    ])
    expect(callLog(ports.calls)).toMatchSnapshot()

    expect(ports.http.calls[0]?.input).toMatchObject({
      method: 'POST',
      headers: { 'x-api-key': TEST_KEY },
    })
    expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 1 })
    expect(ports.facts.values.get('entity-0')).toEqual({
      description:
        'Warehouse picking robots that learn a new SKU from one demonstration.',
      founded_year: 2019,
      location: 'Pune, India',
      linkedin: 'http://www.linkedin.com/company/northwind-robotics',
    })
    expect(ports.facts.calls[0]?.input).toMatchObject({
      receiptId: 'receipt-1',
    })
  })

  it('stores a no-match receipt with no credit and calls nothing else', async () => {
    const ports = portsFor(company, ORG_URL, {
      body: fixture('organization-not-found.json'),
    })
    expect((await run(jobs.enrichCompany, ports))._tag).toBe('Success')
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Secrets.get',
      'Http.request',
      'Receipts.store',
      'Log.info',
    ])
    expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 0 })
  })

  it.each([
    [403, 'error-403.json'],
    [402, 'error-402.json'],
  ])(
    'fails JobPermanent on a %i, carrying Apollo’s own sentence',
    async (status, name) => {
      const body = fixture(name)
      const ports = portsFor(company, ORG_URL, { status, body })
      const exit = await run(jobs.enrichCompany, ports)
      const sentence = z.object({ error: z.string() }).parse(body).error
      const failure = JSON.stringify(failureOf(exit))
      expect(failure).toContain('JobPermanent')
      expect(failure).toContain(
        JSON.stringify(
          `Apollo organizations/enrich answered ${status}: ${sentence}`,
        ).slice(1, -1),
      )
      expect(failure).not.toContain(TEST_KEY)
      // Nothing written: a refused call costs no receipt.
      expect(ports.calls.map((c) => c.port)).toEqual([
        'Read',
        'Secrets',
        'Http',
      ])
    },
  )

  it('retries a 5xx', async () => {
    const ports = portsFor(company, ORG_URL, {
      status: 503,
      body: { error: 'Service Unavailable' },
    })
    const failure = JSON.stringify(
      failureOf(await run(jobs.enrichCompany, ports)),
    )
    expect(failure).toContain('JobRetryable')
  })

  it('fails permanently for a company with no domain, having asked Apollo nothing', async () => {
    const ports = testPorts({
      secret: TEST_KEY,
      entities: [readEntity({ id: 'entity-0', name: 'No domain' })],
    })
    const exit = await run(jobs.enrichCompany, ports)
    expect(JSON.stringify(failureOf(exit))).toContain('has no domain')
    expect(ports.calls.map((c) => c.method)).toEqual(['entity'])
  })
})

describe('enrichPerson', () => {
  it('matches by email and adds the email before filling, LinkedIn among the values', async () => {
    const ports = portsFor(person, PERSON_URL, { body: fixture('person.json') })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(callLog(ports.calls)).toMatchSnapshot()
    expect(ports.identity.calls[0]?.input).toEqual({
      entityId: 'entity-0',
      keys: {
        email: 'meera@northwind-robotics.example',
      },
    })
    expect(ports.facts.values.get('entity-0')).toEqual({
      job_title: 'Co-founder & CTO',
      location: 'Pune, India',
      linkedin: 'http://www.linkedin.com/in/meera-kulkarni-robots',
      twitter: 'https://twitter.com/meerak',
    })
  })

  it('asks by the LinkedIn value when the person has no email', async () => {
    const linkedin = 'https://www.linkedin.com/in/meera-kulkarni-robots'
    const byLinkedin = readEntity({
      id: 'entity-0',
      kind: 'person',
      name: 'Meera Kulkarni',
      values: { linkedin },
    })
    const ports = portsFor(
      byLinkedin,
      endpointUrl('people/match', { linkedin_url: linkedin }),
      { body: fixture('person.json') },
    )
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.http.calls).toHaveLength(1)
  })

  it('records no identity call for a match that returns only a role email', async () => {
    const ports = portsFor(person, PERSON_URL, {
      body: fixture('person-role-email.json'),
    })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.identity.calls).toEqual([])
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Secrets.get',
      'Http.request',
      'Receipts.store',
      'Log.info',
    ])
  })

  it('refuses a company record', async () => {
    const ports = testPorts({ secret: TEST_KEY, entities: [company] })
    const exit = await run(jobs.enrichPerson, ports)
    expect(JSON.stringify(failureOf(exit))).toContain('JobPermanent')
    expect(ports.http.calls).toEqual([])
  })
})

describe('signals', () => {
  it('logs the latest funding round once, citing the receipt, and writes no value for it', async () => {
    const ports = portsFor(company, ORG_URL, {
      body: fixture('organization.json'),
    })
    expect((await run(jobs.enrichCompany, ports))._tag).toBe('Success')
    expect(ports.content.calls.map((c) => c.input)).toEqual([
      {
        _tag: 'signal',
        entityId: 'entity-0',
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
        receiptId: 'receipt-1',
      },
    ])
    const filled = ports.facts.values.get('entity-0') ?? {}
    expect(Object.keys(filled).sort()).toEqual([
      'description',
      'founded_year',
      'linkedin',
      'location',
    ])
  })

  it('logs a changed title as a hiring signal dated by the current role', async () => {
    const held = readEntity({
      ...person,
      values: { job_title: 'Head of Engineering' },
    })
    const ports = portsFor(held, PERSON_URL, { body: fixture('person.json') })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.content.calls.map((c) => c.input)).toEqual([
      {
        _tag: 'signal',
        entityId: 'entity-0',
        kind: 'hiring',
        title: 'Now Co-founder & CTO at Northwind Robotics',
        publishedAt: '2019-01-01T00:00:00.000Z',
        payload: {
          from: 'Head of Engineering',
          to: 'Co-founder & CTO',
          at: 'Northwind Robotics',
        },
        receiptId: 'receipt-1',
      },
    ])
  })

  it('logs no hiring signal when the title is unchanged or was never held', async () => {
    for (const values of [{ job_title: 'Co-founder & CTO' }, {}]) {
      const ports = portsFor(readEntity({ ...person, values }), PERSON_URL, {
        body: fixture('person.json'),
      })
      expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
      expect(ports.content.calls).toEqual([])
    }
  })
})

describe('autoEnrich', () => {
  const fired = (
    event: EventInput['event'],
    ports: ReturnType<typeof testPorts>,
  ) =>
    Effect.runPromiseExit(
      jobs.autoEnrich({ event }).pipe(Effect.provide(ports.layer)),
    )
  const base = { entityId: 'entity-0', occurredAt: '2026-10-02T12:00:00Z' }
  const triggers: ReadonlyArray<EventInput['event']> = [
    { ...base, name: 'entity.created', kind: 'company' },
    { ...base, name: 'filed', kind: 'company', spaceId: 'space-1' },
    { ...base, name: 'deal.linked', kind: 'company', dealId: 'deal-1' },
  ]

  it.each(triggers.map((t): [string, EventInput['event']] => [t.name, t]))(
    'enriches a company with a domain on %s exactly as the action does',
    async (_, event) => {
      const ports = portsFor(company, ORG_URL, {
        body: fixture('organization.json'),
      })
      expect((await fired(event, ports))._tag).toBe('Success')
      expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
        'Read.entity',
        'Secrets.get',
        'Http.request',
        'Receipts.store',
        'Identity.addAlias',
        'Facts.fill',
        'Content.emitSignal',
        'Log.info',
      ])
      expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 1 })
    },
  )

  it('enriches a person who joins a deal, by email', async () => {
    const ports = portsFor(person, PERSON_URL, { body: fixture('person.json') })
    const exit = await fired(
      { ...base, name: 'deal.linked', kind: 'person', dealId: 'deal-1' },
      ports,
    )
    expect(exit._tag).toBe('Success')
    expect(ports.http.calls).toHaveLength(1)
    expect(ports.facts.values.get('entity-0')).toMatchObject({
      job_title: 'Co-founder & CTO',
    })
  })

  it('declines a company with no domain without a key, a call or a credit', async () => {
    const ports = testPorts({
      secret: TEST_KEY,
      entities: [readEntity({ id: 'entity-0', name: 'No domain' })],
    })
    const exit = await fired(
      { ...base, name: 'entity.created', kind: 'company' },
      ports,
    )
    expect(exit._tag).toBe('Success')
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Log.info',
    ])
    expect(ports.http.calls).toEqual([])
    expect(ports.receipts.calls).toEqual([])
  })

  it('declines a deal before reading anything', async () => {
    const ports = testPorts({ secret: TEST_KEY, entities: [person] })
    const exit = await fired(
      { ...base, name: 'entity.created', kind: 'deal' },
      ports,
    )
    expect(exit._tag).toBe('Success')
    expect(ports.calls).toEqual([])
  })
})

describe('cost', () => {
  it('is one credit per record, from the input alone', () => {
    for (const { cost } of [jobs.enrichCompany, jobs.enrichPerson]) {
      expect(cost({ entityIds: ['a', 'b', 'c'] })).toEqual({ credits: 3 })
      expect(cost({ entityIds: [], fields: ['description'] })).toEqual({
        credits: 0,
      })
    }
  })
})
