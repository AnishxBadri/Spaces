import { Effect, Exit, Redacted } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { PortName } from '../contract.ts'
import { Content, Facts, Http, Identity, Log, Read, Secrets } from '../ports.ts'
import type { PortServices } from '../ports.ts'
import {
  ContentTest,
  FactsTest,
  HttpTest,
  IdentityTest,
  ReadTest,
  SecretsTest,
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
    expect(result.aliases.keys).toEqual([
      { key: 'domain', outcome: 'suggested_duplicate' },
      { key: 'linkedin', outcome: 'added' },
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
