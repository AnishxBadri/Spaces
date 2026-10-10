import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { PortName } from '../contract.ts'
import {
  Ai,
  Content,
  Facts,
  Http,
  Identity,
  Import,
  Log,
  Read,
  Secrets,
  Spaces,
  watchSettingsOf,
} from '../ports.ts'
import type { PortServices, SpaceBrief } from '../ports.ts'
import {
  AiTest,
  CALENDAR_API,
  ContentTest,
  FactsTest,
  HttpTest,
  IdentityTest,
  ImportTest,
  ReadTest,
  SecretsTest,
  SpacesTest,
  makeFakeCalendarApi,
  readEntity,
  testPorts,
} from './index.ts'

const failureOf = <TValue, TError>(exit: Exit.Exit<TValue, TError>) => {
  if (Exit.isSuccess(exit)) throw new Error('expected a failure')
  const reason = exit.cause.reasons.find((r) => r._tag === 'Fail')
  if (reason?._tag !== 'Fail') throw new Error('expected a typed failure')
  return reason.error
}

it('PortServices has exactly the PORT_NAMES keys', () => {
  expectTypeOf<keyof PortServices>().toEqualTypeOf<PortName>()
})

describe('IdentityTest', () => {
  it('returns the same fake id for the same normalized keys within a run', () => {
    const identity = IdentityTest()
    const [a, b, c] = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Identity
        return [
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'Stripe.com' },
          }),
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'https://www.stripe.com/pricing' },
          }),
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'adyen.com' },
          }),
        ]
      }).pipe(Effect.provide(identity.layer)),
    )
    expect(a).toEqual({ entityId: 'entity-1', outcome: 'created' })
    expect(b).toEqual({ entityId: 'entity-1', outcome: 'attached' })
    expect(c).toEqual({ entityId: 'entity-2', outcome: 'created' })
    expect(identity.calls.map((call) => call.method)).toEqual([
      'resolve',
      'resolve',
      'resolve',
    ])
  })

  it('normalizes keys as the choke point does — the real normalizers', () => {
    const identity = IdentityTest()
    const [company, sub, freeMail, ada, adaDotted] = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Identity
        return [
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'stripe.co.uk' },
          }),
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'app.stripe.co.uk' },
          }),
          // A free-mail domain identifies nothing: a name-only birth.
          yield* port.resolve({
            kind: 'company',
            keys: { domain: 'gmail.com' },
            name: 'Gmail',
          }),
          yield* port.resolve({
            kind: 'person',
            keys: { email: 'ada.lovelace@gmail.com' },
          }),
          yield* port.resolve({
            kind: 'person',
            keys: { email: 'AdaLovelace+vc@gmail.com' },
          }),
        ]
      }).pipe(Effect.provide(identity.layer)),
    )
    expect(sub.entityId).toBe(company.entityId)
    expect(freeMail).toEqual({ entityId: 'entity-2', outcome: 'created' })
    expect(adaDotted.entityId).toBe(ada.entityId)
  })

  it('attaches to a known entity and reports alias outcomes', () => {
    const identity = IdentityTest({
      known: { 'entity-7': { domain: 'stripe.com' } },
    })
    const result = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Identity
        const r = yield* port.resolve({
          kind: 'company',
          keys: { domain: 'stripe.com' },
        })
        const aliases = yield* port.addAlias({
          entityId: 'entity-99',
          keys: {
            domain: 'stripe.com',
            linkedin: 'linkedin.com/company/stripe',
          },
        })
        return { r, aliases }
      }).pipe(Effect.provide(identity.layer)),
    )
    expect(result.r).toEqual({ entityId: 'entity-7', outcome: 'attached' })
    // A LinkedIn URL identifies nobody, so it is no claim at all.
    expect(result.aliases.keys).toEqual([
      { key: 'domain', outcome: 'suggested_duplicate' },
    ])
  })
})

describe('FactsTest', () => {
  it("fills blanks and returns a human's value as a conflict", () => {
    const facts = FactsTest({ human: { 'entity-1': { founded_year: 2018 } } })
    const result = Effect.runSync(
      Facts.use((port) =>
        port.fill({
          entityId: 'entity-1',
          values: { founded_year: 2019, location: 'Pune' },
        }),
      ).pipe(Effect.provide(facts.layer)),
    )
    expect(result.conflicts).toEqual([
      { slug: 'founded_year', existing: 2018, proposed: 2019 },
    ])
    expect(facts.values.get('entity-1')).toEqual({ location: 'Pune' })
  })
})

describe('ContentTest', () => {
  it('dedupes interactions on messageId, as the lane does', () => {
    const content = ContentTest()
    const ids = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Content
        const mail = {
          _tag: 'interaction',
          kind: 'email',
          occurredAt: '2026-09-30T10:00:00Z',
          entityIds: ['entity-1'],
          messageId: '<m1@example.com>',
        } as const
        const a = yield* port.logInteraction(mail)
        const b = yield* port.logInteraction(mail)
        const { messageId: _, ...unkeyed } = mail
        const c = yield* port.logInteraction(unkeyed)
        const d = yield* port.logInteraction(unkeyed)
        return [a, b, c, d].map((r) => r.interactionId)
      }).pipe(Effect.provide(content.layer)),
    )
    expect(ids).toEqual([
      'interaction-1',
      'interaction-1',
      'interaction-2',
      'interaction-3',
    ])
  })

  it('keys meetings on uid, and finds a bare cancellation by event id', () => {
    const content = ContentTest()
    const outcomes = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Content
        const meeting = {
          _tag: 'meeting',
          uid: 'evt@google.com',
          eventId: 'evt',
          status: 'scheduled',
          startsAt: '2026-10-12T10:00:00Z',
          endsAt: '2026-10-12T11:00:00Z',
          attendees: [{ email: 'jane@acme.example', rsvp: 'accepted' }],
        } as const
        return [
          yield* port.logMeeting(meeting),
          yield* port.logMeeting({ ...meeting, status: 'cancelled' }),
          yield* port.logMeeting({ _tag: 'meeting-cancelled', eventId: 'evt' }),
          yield* port.logMeeting({ _tag: 'meeting-cancelled', eventId: 'x' }),
        ]
      }).pipe(Effect.provide(content.layer)),
    )
    expect(outcomes).toEqual([
      { outcome: 'created', interactionId: 'interaction-1' },
      { outcome: 'updated', interactionId: 'interaction-1' },
      { outcome: 'updated', interactionId: 'interaction-1' },
      { outcome: 'refused', reason: 'no meeting holds this event' },
    ])
  })

  it('writes a keyed signal once per record, and an unkeyed one every time', () => {
    const content = ContentTest()
    const ids = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Content
        const round = {
          _tag: 'signal',
          entityId: 'entity-1',
          kind: 'funding',
          key: 'funding:Series A:2024-03-01',
        } as const
        const a = yield* port.emitSignal(round)
        const b = yield* port.emitSignal(round)
        const c = yield* port.emitSignal({ ...round, entityId: 'entity-2' })
        const { key: _, ...unkeyed } = round
        const d = yield* port.emitSignal(unkeyed)
        const e = yield* port.emitSignal(unkeyed)
        return [a, b, c, d, e].map((r) => r.signalId)
      }).pipe(Effect.provide(content.layer)),
    )
    expect(ids).toEqual([
      'signal-1',
      'signal-1',
      'signal-2',
      'signal-3',
      'signal-4',
    ])
    expect(content.signals).toHaveLength(4)
  })
})

describe('ReadTest', () => {
  it('answers null for an entity it was not given — as for one it may not read', () => {
    const read = ReadTest({
      entities: [readEntity({ id: 'entity-1', name: 'Stripe' })],
    })
    const [known, unknown, hits] = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Read
        return [
          yield* port.entity('entity-1'),
          yield* port.entity('entity-2'),
          yield* port.search('strip'),
        ] as const
      }).pipe(Effect.provide(read.layer)),
    )
    expect(known?.name).toBe('Stripe')
    expect(unknown).toBeNull()
    expect(hits).toEqual([
      { entityId: 'entity-1', kind: 'company', name: 'Stripe' },
    ])
  })
})

describe('SecretsTest', () => {
  it('hands back a redacted secret and never records it', () => {
    const secrets = SecretsTest({ secret: 'sk_live_123' })
    const value = Effect.runSync(
      Secrets.use((port) => port.get()).pipe(Effect.provide(secrets.layer)),
    )
    expect(Redacted.value(value)).toBe('sk_live_123')
    expect(JSON.stringify(secrets.calls)).not.toContain('sk_live_123')
  })

  it('fails NotConnected for accessToken without a connection', () => {
    const exit = Effect.runSyncExit(
      Secrets.use((port) => port.accessToken()).pipe(
        Effect.provide(SecretsTest().layer),
      ),
    )
    expect(failureOf(exit)._tag).toBe('NotConnected')
  })
})

describe('HttpTest', () => {
  const url =
    'https://api.example.com/v1/organizations/enrich?domain=stripe.com'

  it('records the exact request headers and scripts the response', () => {
    const http = HttpTest([
      { url, response: { body: { organization: { name: 'Stripe' } } } },
    ])
    const response = Effect.runSync(
      Http.use((port) =>
        port.request({
          method: 'GET',
          url,
          headers: { 'X-Api-Key': 'test-key', Accept: 'application/json' },
        }),
      ).pipe(Effect.provide(http.layer)),
    )
    expect(JSON.parse(response.body)).toEqual({
      organization: { name: 'Stripe' },
    })
    expect(http.calls[0]?.input).toEqual({
      method: 'GET',
      url,
      headers: { 'x-api-key': 'test-key', accept: 'application/json' },
    })
  })

  it('maps a scripted 429 to JobRateLimited with Retry-After, then serves the retry', () => {
    const http = HttpTest([
      { url, response: { status: 429, headers: { 'Retry-After': '30' } } },
      { url, response: { status: 200, body: '{}' } },
    ])
    const call = Http.use((port) => port.request({ method: 'GET', url }))
    const first = Effect.runSyncExit(call.pipe(Effect.provide(http.layer)))
    expect(failureOf(first)).toMatchObject({
      _tag: 'JobRateLimited',
      retryAfterMs: 30_000,
    })
    const second = Effect.runSync(call.pipe(Effect.provide(http.layer)))
    expect(second.status).toBe(200)
  })

  it('fails an unscripted request permanently, naming it — nothing reaches a network', () => {
    const exit = Effect.runSyncExit(
      Http.use((port) => port.request({ method: 'POST', url })).pipe(
        Effect.provide(HttpTest().layer),
      ),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'JobPermanent',
      reason: `HttpTest: no scripted response for POST ${url}`,
    })
  })
})

describe('ImportTest', () => {
  const grid = {
    columns: ['Name', 'Business model'],
    rows: [
      { ordinal: 1, cells: ['Acme', ['B2B', 'Marketplace']] },
      { ordinal: 2, cells: ['Beta'] },
    ],
  }

  it('lands the grid as the live port does, and a second stage writes nothing', () => {
    const importer = ImportTest()
    const [first, second] = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Import
        return [yield* port.stage(grid), yield* port.stage(grid)]
      }).pipe(Effect.provide(importer.layer)),
    )
    expect(first).toEqual({
      batchId: 'batch-1',
      staged: 2,
      malformed: [],
      refused: [],
    })
    expect(second).toEqual(first)
    expect(importer.rows).toEqual([
      { rowNum: 1, cells: ['Acme', 'B2B,Marketplace'], reason: null },
      { rowNum: 2, cells: ['Beta', ''], reason: null },
    ])
  })

  it('fails permanently on a grid with no row it could place', () => {
    const exit = Effect.runSyncExit(
      Import.use((port) => port.stage({ columns: ['Name'], rows: [] })).pipe(
        Effect.provide(ImportTest().layer),
      ),
    )
    expect(failureOf(exit)).toMatchObject({
      _tag: 'JobPermanent',
      reason: 'the grid has no row that could be placed',
    })
  })
})

describe('AiTest', () => {
  const items = [{ ref: 'event:signal-1', text: 'Raised a Series A' }] as const

  it('answers a plain call with the scripted text, and a default without one', () => {
    const ai = AiTest({ answers: { synthesize: { text: 'A brief.' } } })
    const [brief, label] = Effect.runSync(
      Effect.gen(function* () {
        const port = yield* Ai
        return [
          yield* port.complete('synthesize', items),
          yield* port.complete('extract', items),
        ]
      }).pipe(Effect.provide(ai.layer)),
    )
    expect(brief).toBe('A brief.')
    expect(label).toBe('extract answer')
    expect(ai.calls.at(0)).toEqual({
      port: 'Ai',
      method: 'complete',
      input: { lane: 'synthesize', items },
      output: 'A brief.',
    })
  })

  it('parses a structured answer with the schema, and fails when it does not fit', () => {
    const schema = z.object({ label: z.enum(['funding', 'other']) })
    const ai = AiTest({
      answers: { classify: { object: { label: 'funding' } } },
    })
    const answer = Effect.runSync(
      Effect.gen(function* () {
        return yield* (yield* Ai).complete('classify', items, schema)
      }).pipe(Effect.provide(ai.layer)),
    )
    expect(answer).toEqual({ label: 'funding' })

    const refused = Effect.runSyncExit(
      Effect.gen(function* () {
        return yield* (yield* Ai).complete('extract', items, schema)
      }).pipe(Effect.provide(ai.layer)),
    )
    expect(failureOf(refused)._tag).toBe('JobPermanent')
  })
})

describe('SpacesTest', () => {
  const brief: SpaceBrief = {
    space: { id: 'space-1', name: 'Launch', criteria: 'Small-lift launch.' },
    path: [
      { id: 'space-0', name: 'Spacetech' },
      { id: 'space-1', name: 'Launch' },
    ],
    memos: [],
    terms: [],
    members: [],
    memberCount: 0,
    tree: { id: 'space-1', name: 'Launch', companies: 0, children: [] },
  }

  it('answers the seeded brief and refuses any other space', () => {
    const spaces = SpacesTest({ briefs: [brief] })
    const got = Effect.runSync(
      Effect.gen(function* () {
        return yield* (yield* Spaces).brief('space-1')
      }).pipe(Effect.provide(spaces.layer)),
    )
    expect(got).toBe(brief)
    const refused = Effect.runSyncExit(
      Effect.gen(function* () {
        return yield* (yield* Spaces).brief('space-9')
      }).pipe(Effect.provide(spaces.layer)),
    )
    expect(failureOf(refused)._tag).toBe('JobPermanent')
    expect(spaces.calls.map((c) => c.input)).toEqual(['space-1', 'space-9'])
  })
})

describe('watchSettingsOf', () => {
  const job = { settings: z.object({ cap: z.int().default(25) }) }

  it("parses a watch's settings by the job's schema, defaults applied", () => {
    expect(
      Effect.runSync(watchSettingsOf(job, { watchId: 'w-1', settings: {} })),
    ).toEqual({ cap: 25 })
  })

  it('fails permanently on settings that do not parse', () => {
    const exit = Effect.runSyncExit(
      watchSettingsOf(job, { watchId: 'w-1', settings: { cap: 'many' } }),
    )
    expect(failureOf(exit)._tag).toBe('JobPermanent')
  })
})

describe('testPorts', () => {
  it('records every port call in order over one Layer', () => {
    const ports = testPorts()
    Effect.runSync(
      Effect.gen(function* () {
        const identity = yield* Identity
        const facts = yield* Facts
        const log = yield* Log
        const { entityId } = yield* identity.resolve({
          kind: 'person',
          keys: { email: 'ada@example.com' },
        })
        yield* facts.fill({ entityId, values: { job_title: 'CTO' } })
        yield* log.info('filled', { entityId })
      }).pipe(Effect.provide(ports.layer)),
    )
    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Identity.resolve',
      'Facts.fill',
      'Log.info',
    ])
    expect(ports.facts.values.get('entity-1')).toEqual({ job_title: 'CTO' })
    expect(ports.log.lines).toEqual([
      { level: 'info', message: 'filled', fields: { entityId: 'entity-1' } },
    ])
  })
})

describe('makeFakeCalendarApi', () => {
  const list = async (
    api: ReturnType<typeof makeFakeCalendarApi>,
    query: string,
  ) => {
    const res = await api.fetch(
      `${CALENDAR_API}/calendars/primary/events?${query}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${api.accessToken}` },
      },
    )
    return { status: res.status, body: z.json().parse(await res.json()) }
  }

  it('filters a full list on timeMin, and without one lists all of history', async () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    const api = makeFakeCalendarApi({ now })
    const all = await list(api, 'singleEvents=true')
    const bounded = await list(
      api,
      'singleEvents=true&timeMin=2026-10-10T09:00:00Z',
    )
    expect(JSON.stringify(all.body)).toContain('board-2021')
    expect(JSON.stringify(bounded.body)).not.toContain('board-2021')
    expect(JSON.stringify(bounded.body)).toContain('acme-catchup')
  })

  it('answers 410 to an expired sync token, 400 to a token with a filter, 401 once revoked', async () => {
    const api = makeFakeCalendarApi()
    const first = await list(api, 'singleEvents=true')
    const token = z
      .object({ nextSyncToken: z.string() })
      .parse(first.body).nextSyncToken
    expect(
      (await list(api, `singleEvents=true&syncToken=${token}&timeMin=x`))
        .status,
    ).toBe(400)
    api.expireSyncTokens()
    expect(
      (await list(api, `singleEvents=true&syncToken=${token}`)).status,
    ).toBe(410)
    api.revoke()
    expect((await list(api, 'singleEvents=true')).status).toBe(401)
  })
})
