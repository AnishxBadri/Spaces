import { Effect, Exit } from 'effect'
import { z } from 'zod'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import type { RecordedCall } from '@spaces/sdk/testing'
import type { ReadEntity } from '@spaces/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobs } from './index.ts'
import { APOLLO_API } from './map.ts'
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
    cin: [],
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
    cin: [],
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
  it('matches by email and adds the email and LinkedIn before filling', async () => {
    const ports = portsFor(person, PERSON_URL, { body: fixture('person.json') })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(callLog(ports.calls)).toMatchSnapshot()
    expect(ports.identity.calls[0]?.input).toEqual({
      entityId: 'entity-0',
      keys: {
        email: 'meera@northwind-robotics.example',
        linkedin: 'http://www.linkedin.com/in/meera-kulkarni-robots',
      },
    })
    expect(ports.facts.values.get('entity-0')).toEqual({
      job_title: 'Co-founder & CTO',
      location: 'Pune, India',
      linkedin: 'http://www.linkedin.com/in/meera-kulkarni-robots',
      twitter: 'https://twitter.com/meerak',
    })
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

describe('onCompanyCreated', () => {
  const created = (kind: 'company' | 'person' | 'deal') =>
    jobs
      .onCompanyCreated({
        event: {
          name: 'entity.created',
          entityId: 'entity-0',
          kind,
          occurredAt: '2026-10-02T12:00:00Z',
        },
      })
      .pipe(Effect.provide(ports.layer))
  let ports = testPorts({ secret: TEST_KEY })

  it('enriches a new company with a domain exactly as the action does', async () => {
    ports = portsFor(company, ORG_URL, { body: fixture('organization.json') })
    expect((await Effect.runPromiseExit(created('company')))._tag).toBe(
      'Success',
    )
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Secrets.get',
      'Http.request',
      'Receipts.store',
      'Identity.addAlias',
      'Facts.fill',
      'Log.info',
    ])
    expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 1 })
  })

  it('declines a company with no domain without a key, a call or a credit', async () => {
    ports = testPorts({
      secret: TEST_KEY,
      entities: [readEntity({ id: 'entity-0', name: 'No domain' })],
    })
    expect((await Effect.runPromiseExit(created('company')))._tag).toBe(
      'Success',
    )
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Read.entity',
      'Log.info',
    ])
    expect(ports.http.calls).toEqual([])
    expect(ports.receipts.calls).toEqual([])
  })

  it.each(['person', 'deal'] as const)(
    'declines a new %s before reading anything',
    async (kind) => {
      ports = testPorts({ secret: TEST_KEY, entities: [person] })
      expect((await Effect.runPromiseExit(created(kind)))._tag).toBe('Success')
      expect(ports.calls).toEqual([])
    },
  )
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
