import { Effect, Exit } from 'effect'
import { Ai, JobPermanent } from '@spaces/sdk'
import { readEntity } from '@spaces/sdk/testing'
import type { RecordedCall } from '@spaces/sdk/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobs } from './index.ts'
import { EXA_SEARCH_URL } from './map.ts'
import {
  TEST_KEY,
  company,
  fixedClock,
  portsFor,
  replay,
} from './test-fixtures.ts'

/**
 * The research job on the SDK's recording Layers, against the cassette: no
 * database, no network, no integration row. `fetch` is replaced by one that
 * throws, so a request that escaped the Http port would fail the test rather
 * than reach Exa.
 */
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the Exa tests must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

type Ports = ReturnType<typeof portsFor>

const run = (ports: Ports, entityId = 'entity-0') =>
  Effect.runPromiseExit(
    jobs
      .research({ entityId })
      .pipe(Effect.provide(ports.layer), Effect.provide(fixedClock)),
  )

/** The call log, with the response body (the fixture again) left out. */
const callLog = (calls: ReadonlyArray<RecordedCall>) =>
  calls.map(({ port, method, input, output }) =>
    port === 'Http'
      ? { call: `${port}.${method}`, input }
      : { call: `${port}.${method}`, input, output },
  )

const failureOf = (exit: Exit.Exit<void, unknown>): string =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ''

const HIT_URLS = [
  'https://news.example/2026/09/northwind-robotics-series-a',
  'https://blog.example/warehouse-picking-2026',
  'https://jobs.example/northwind-robotics/ml-engineer',
  'https://trade.example/logistics/northwind-pilot',
  'https://podcast.example/episodes/142',
]

describe('research, against the cassette', () => {
  it('emits one web signal per hit and proposes exactly one note citing them', async () => {
    const ports = portsFor([replay('five pages')])
    const exit = await run(ports)
    expect(exit._tag).toBe('Success')

    expect(ports.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
      'Config.get',
      'Read.entity',
      'Secrets.get',
      'Http.request',
      'Ai.complete',
      'Content.emitSignal',
      'Content.emitSignal',
      'Content.emitSignal',
      'Content.emitSignal',
      'Content.emitSignal',
      'Judgment.suggest',
    ])

    // One signal per hit, each carrying its URL.
    expect(ports.content.signals.map((s) => [s.kind, s.url])).toEqual(
      HIT_URLS.map((url) => ['web', url]),
    )

    // Exactly one suggestion: a note whose refs are the hits' signals, with
    // the prompt's place-holding refs replaced by the signals they became.
    expect(ports.judgment.calls).toHaveLength(1)
    expect(ports.judgment.calls.at(0)?.input).toEqual({
      entityId: 'entity-0',
      proposal: {
        kind: 'note',
        body: 'Northwind Robotics raised a $6.5M Series A [event:signal-1] and is hiring a manipulation team [event:signal-3].',
      },
      rationale: 'Exa web research: 5 pages',
      refs: [
        'event:signal-1',
        'event:signal-2',
        'event:signal-3',
        'event:signal-4',
        'event:signal-5',
      ],
    })
    expect(callLog(ports.calls)).toMatchSnapshot()
  })

  it('asks Exa for the name and domain, the default five pages and the last 90 days, with the key in x-api-key', async () => {
    const ports = portsFor([replay('five pages')])
    await run(ports)
    expect(ports.http.calls.at(0)?.input).toEqual({
      method: 'POST',
      url: EXA_SEARCH_URL,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': TEST_KEY,
      },
      body: {
        query: 'Northwind Robotics (northwind-robotics.example)',
        type: 'auto',
        numResults: 5,
        startPublishedDate: '2026-07-12T00:00:00.000Z',
        contents: { highlights: true },
      },
    })
  })

  it('reads maxResults and lookbackDays from its settings', async () => {
    const ports = portsFor([replay('five pages')], {
      config: { maxResults: 10, lookbackDays: 30 },
    })
    await run(ports)
    expect(ports.http.calls.at(0)?.input).toMatchObject({
      body: { numResults: 10, startPublishedDate: '2026-09-10T00:00:00.000Z' },
    })
  })

  it('asks by the name alone for a company with no domain', async () => {
    const ports = portsFor([replay('five pages')], {
      entities: [readEntity({ id: 'entity-0', name: 'Northwind Robotics' })],
    })
    await run(ports)
    expect(ports.http.calls.at(0)?.input).toMatchObject({
      body: { query: 'Northwind Robotics' },
    })
  })

  it('writes the same pages once: a second run emits under the same keys and nothing new is written', async () => {
    const ports = portsFor([replay('five pages', { repeat: true })])
    expect((await run(ports))._tag).toBe('Success')
    expect((await run(ports))._tag).toBe('Success')
    expect(ports.content.signals).toHaveLength(5)
    expect(ports.content.signals.map((s) => s.key)).toEqual(
      HIT_URLS.map((url) => `web:${url}`),
    )
    expect(ports.judgment.calls.at(1)?.input).toMatchObject({
      refs: [1, 2, 3, 4, 5].map((n) => `event:signal-${n}`),
    })
  })

  it('proposes nothing and spends no AI when Exa finds nothing', async () => {
    const ports = portsFor([replay('nothing found')])
    expect((await run(ports))._tag).toBe('Success')
    expect(ports.ai.calls).toEqual([])
    expect(ports.content.calls).toEqual([])
    expect(ports.judgment.calls).toEqual([])
  })
})

describe('research, when it cannot', () => {
  it.each([
    [
      'revoked key',
      'JobPermanent',
      'Exa search answered 401: Invalid API key. Check the key in your Exa dashboard and try again.',
    ],
    [
      'out of credits',
      'JobPermanent',
      'Exa search answered 402: You have run out of credits. Add credits at dashboard.exa.ai to keep searching.',
    ],
  ])(
    'fails with Exa’s own sentence for the %s answer, having written nothing',
    async (name, tag, reason) => {
      const ports = portsFor([replay(name)])
      const failure = failureOf(await run(ports))
      expect(failure).toContain(tag)
      expect(failure).toContain(reason)
      expect(failure).not.toContain(TEST_KEY)
      expect(ports.ai.calls).toEqual([])
      expect(ports.content.calls).toEqual([])
      expect(ports.judgment.calls).toEqual([])
    },
  )

  it('retries a 5xx, carrying what Exa said', async () => {
    const ports = portsFor([
      {
        method: 'POST',
        url: EXA_SEARCH_URL,
        response: { status: 503, body: { error: 'Service temporarily down' } },
      },
    ])
    const failure = failureOf(await run(ports))
    expect(failure).toContain('JobRetryable')
    expect(failure).toContain(
      'Exa search answered 503: Service temporarily down',
    )
    expect(ports.content.calls).toEqual([])
  })

  it('a body that is not search results is permanent', async () => {
    const ports = portsFor([
      { method: 'POST', url: EXA_SEARCH_URL, response: { body: { ok: 1 } } },
    ])
    const failure = failureOf(await run(ports))
    expect(failure).toContain(
      'Exa search returned a body this plugin cannot read',
    )
  })

  it('with no key configured, fails before Exa is asked anything', async () => {
    const ports = portsFor([replay('five pages')], { secret: null })
    const failure = failureOf(await run(ports))
    expect(failure).toContain('no credential is configured')
    expect(ports.http.calls).toEqual([])
    expect(ports.content.calls).toEqual([])
  })

  it('refuses a record it may not read, or one that is not a company, asking Exa nothing', async () => {
    const person = readEntity({
      id: 'entity-1',
      kind: 'person',
      name: 'Meera Kulkarni',
    })
    for (const entityId of ['entity-elsewhere', 'entity-1']) {
      const ports = portsFor([replay('five pages')], {
        entities: [company, person],
      })
      const failure = failureOf(await run(ports, entityId))
      expect(failure).toContain(
        `${entityId} is not a company this integration can read`,
      )
      expect(ports.http.calls).toEqual([])
    }
  })

  it('a refused AI call leaves no signal behind', async () => {
    const ports = portsFor([replay('five pages')])
    // An Ai that refuses, as the live port does for a sensitive record.
    const refusing = Ai.of({
      complete: () =>
        Effect.fail(
          new JobPermanent({
            reason: 'SensitiveRefused: this record is sensitive',
          }),
        ),
    })
    const exit = await Effect.runPromiseExit(
      jobs
        .research({ entityId: 'entity-0' })
        .pipe(
          Effect.provideService(Ai, refusing),
          Effect.provide(ports.layer),
          Effect.provide(fixedClock),
        ),
    )
    expect(failureOf(exit)).toContain('SensitiveRefused')
    expect(ports.content.calls).toEqual([])
    expect(ports.judgment.calls).toEqual([])
  })
})
