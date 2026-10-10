import { Effect, Exit } from 'effect'
import { z } from 'zod'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import type { RecordedCall } from '@spaces/sdk/testing'
import type { ReadEntity } from '@spaces/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobs } from './index.ts'
import { APOLLO_API, PHONE_CREDITS, endpointUrl } from './map.ts'
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

/** The keys the host links by default: the system attributes' links. */
const SYSTEM_LINKS = [
  'company.description',
  'company.founded_year',
  'company.location',
  'company.linkedin',
  'company.funding_stage',
  'person.title',
  'person.description',
  'person.location',
  'person.linkedin',
  'person.twitter',
  'person.company',
]

type Job = (typeof jobs)['enrichCompany' | 'enrichPerson']

const run = (job: Job, ports: ReturnType<typeof testPorts>) =>
  Effect.runPromiseExit(
    job.run({ entityId: 'entity-0' }).pipe(Effect.provide(ports.layer)),
  )

const portsFor = (
  entity: ReadEntity,
  url: string,
  response: { readonly status?: number; readonly body: unknown },
  more: {
    readonly linked?: ReadonlyArray<string>
    readonly config?: { readonly phone: boolean }
    readonly entities?: ReadonlyArray<ReadEntity>
  } = {},
) =>
  testPorts({
    secret: TEST_KEY,
    entities: [entity, ...(more.entities ?? [])],
    ...(more.linked === undefined ? {} : { linked: more.linked }),
    ...(more.config === undefined ? {} : { config: more.config }),
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
        repeat: true,
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
  it('stores the receipt, adds the aliases, then answers in the vocabulary citing it', async () => {
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
      'Facts.answer',
      'Content.emitSignal',
      'Log.info',
    ])
    expect(callLog(ports.calls)).toMatchSnapshot()

    expect(ports.http.calls[0]?.input).toMatchObject({
      method: 'POST',
      headers: { 'x-api-key': TEST_KEY },
    })
    expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 1 })
    expect(ports.facts.answers.get('entity-0')).toMatchObject({
      'company.description':
        'Warehouse picking robots that learn a new SKU from one demonstration.',
      'company.founded_year': 2019,
      'company.location': 'Pune, India',
      'company.linkedin': 'http://www.linkedin.com/company/northwind-robotics',
      'company.funding_stage': 'Series A',
      'company.headcount': 84,
      'company.total_raised': 6500000,
    })
    expect(ports.facts.calls[0]?.input).toMatchObject({
      receiptId: 'receipt-1',
    })
  })

  it('answers the linked keys and the unlinked ones alike; an unlinked key is in the receipt and in no other port call', async () => {
    const ports = portsFor(
      company,
      ORG_URL,
      { body: fixture('organization.json') },
      { linked: SYSTEM_LINKS },
    )
    expect((await run(jobs.enrichCompany, ports))._tag).toBe('Success')
    const answered = ports.facts.calls[0]?.output
    expect(answered).toEqual({
      linked: [
        'company.description',
        'company.founded_year',
        'company.location',
        'company.linkedin',
        'company.funding_stage',
      ],
      unlinked: [
        'company.total_raised',
        'company.headcount',
        'company.industry',
        'company.keywords',
        'company.tech_stack',
        'company.twitter',
        'company.address',
      ],
    })
    // The unlinked values travel once, in the answer the host keeps in its
    // receipt; nothing else carries them.
    const elsewhere = JSON.stringify(
      ports.calls.filter(
        (c) => c.port !== 'Facts' && c.port !== 'Receipts' && c.port !== 'Http',
      ),
    )
    for (const value of ['machinery', 'Amazon Web Services', 'Baner, Pune'])
      expect(elsewhere).not.toContain(value)
    expect(JSON.stringify(ports.receipts.calls[0]?.input)).toContain(
      'machinery',
    )
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
    expect(ports.facts.answers.get('entity-0')).toMatchObject({
      'person.title': 'Co-founder & CTO',
      'person.location': 'Pune, India',
      'person.linkedin': 'http://www.linkedin.com/in/meera-kulkarni-robots',
      'person.twitter': 'https://twitter.com/meerak',
      'person.company': {
        name: 'Northwind Robotics',
        domain: 'northwind-robotics.example',
      },
    })
  })

  it.each([
    ['unverified', 'person-unverified.json'],
    ['a role address', 'person-role-email.json'],
    ['locked', 'person-locked.json'],
  ])('claims no identity for an email that is %s', async (_why, name) => {
    const ports = portsFor(person, PERSON_URL, { body: fixture(name) })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.identity.calls).toEqual([])
  })

  it('asks for no phone and answers none with the setting off', async () => {
    const ports = portsFor(person, PERSON_URL, {
      body: fixture('person-keyhold.json'),
    })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.http.calls[0]?.input).toMatchObject({ url: PERSON_URL })
    expect(ports.facts.answers.get('entity-0')).not.toHaveProperty(
      'person.phone',
    )
    expect(ports.receipts.calls[0]?.input).toMatchObject({ creditsUsed: 1 })
  })

  it('asks Apollo to reveal the phone with the setting on, answers it and counts the extra credits', async () => {
    const ports = portsFor(
      person,
      endpointUrl('people/match', {
        email: 'meera@northwind-robotics.example',
        reveal_phone_number: 'true',
      }),
      { body: fixture('person-keyhold.json') },
      { config: { phone: true } },
    )
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.facts.answers.get('entity-0')).toMatchObject({
      'person.phone': '+919845012345',
    })
    expect(ports.receipts.calls[0]?.input).toMatchObject({
      creditsUsed: 1 + PHONE_CREDITS,
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
      'Config.get',
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
        key: 'funding:Series A:2024-03-01',
      },
    ])
    const answered = JSON.stringify(ports.facts.answers.get('entity-0') ?? {})
    expect(answered).not.toContain('Blume Ventures')
  })

  it('writes the same round once: a second run emits it under the same key and nothing new is written', async () => {
    const ports = portsFor(company, ORG_URL, {
      body: fixture('organization.json'),
    })
    expect((await run(jobs.enrichCompany, ports))._tag).toBe('Success')
    expect((await run(jobs.enrichCompany, ports))._tag).toBe('Success')
    expect(ports.content.calls.map((c) => c.output)).toEqual([
      { signalId: 'signal-1' },
      { signalId: 'signal-1' },
    ])
    expect(ports.content.signals).toHaveLength(1)
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
        key: 'role:northwind-robotics.example:Co-founder & CTO',
      },
    ])
  })

  it('writes one dated event when the title changed on a second run, however often it runs after', async () => {
    const ports = portsFor(person, PERSON_URL, { body: fixture('person.json') })
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.content.signals).toEqual([])

    // The first run filled the title; Apollo now says another.
    const filled = readEntity({ ...person, values: { job_title: 'CTO' } })
    const later = portsFor(filled, PERSON_URL, {
      body: fixture('person.json'),
    })
    expect((await run(jobs.enrichPerson, later))._tag).toBe('Success')
    expect((await run(jobs.enrichPerson, later))._tag).toBe('Success')
    expect(later.content.signals.map((s) => s.title)).toEqual([
      'Now Co-founder & CTO at Northwind Robotics',
    ])
  })

  it('reads the companies the person links and logs a move away from one', async () => {
    const keyhold = readEntity({
      id: 'entity-9',
      name: 'Keyhold',
      keys: { domain: ['keyhold.example'], email: [], linkedin: [] },
    })
    const moved = readEntity({
      ...person,
      values: { job_title: 'COO', companies: ['entity-9'] },
    })
    const ports = portsFor(
      moved,
      PERSON_URL,
      { body: fixture('person.json') },
      { entities: [keyhold] },
    )
    expect((await run(jobs.enrichPerson, ports))._tag).toBe('Success')
    expect(ports.read.calls.map((c) => c.input)).toEqual([
      { id: 'entity-0' },
      { id: 'entity-9' },
    ])
    expect(ports.content.signals.map((s) => s.title)).toEqual([
      'Moved from Keyhold to Northwind Robotics as Co-founder & CTO',
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
