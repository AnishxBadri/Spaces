import { Effect, Exit } from 'effect'
import type { JsonObject, WatchInput, WatchOutput } from '@spaces/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { jobs } from './index.ts'
import {
  CRITERIA,
  SPACE_ID,
  TEST_KEY,
  WATCH_ID,
  brief,
  fixtureText,
  northwind,
  replay,
  watchPortsFor,
} from './test-fixtures.ts'
import { EXA_WEBSETS_URL, websetUrl } from './webset.ts'

/**
 * The watch job on the SDK's recording Layers and a Discover that answers
 * as the host does, against the cassette: no database, no network. `fetch`
 * throws, so a request that escaped the Http port fails the test.
 */
beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('the Exa tests must not reach the network')
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
})

type Ports = ReturnType<typeof watchPortsFor>

const run = (ports: Ports, input: Partial<WatchInput> = {}) =>
  Effect.runPromiseExit(
    jobs
      .watch({
        watchId: WATCH_ID,
        spaceId: SPACE_ID,
        settings: {},
        state: null,
        ...input,
      })
      .pipe(Effect.provide(ports.layer)),
  )

const stateOf = (exit: Exit.Exit<WatchOutput, unknown>): JsonObject | null => {
  if (Exit.isFailure(exit)) throw new Error(JSON.stringify(exit.cause))
  return exit.value.state
}

const failureOf = (exit: Exit.Exit<WatchOutput, unknown>): string =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : ''

const WEBSET_ID = 'webset_01k79q2zx3'
const ITEMS_URL = `${EXA_WEBSETS_URL}/${WEBSET_ID}/items?limit=50`
const NEXT_URL = `${ITEMS_URL}&cursor=witem_01k79q3a07`
const itemId = (n: number) => `witem_01k79q3a0${n}`

const requests = (ports: Ports) =>
  ports.http.calls.map((c) => {
    const input = c.input
    return typeof input === 'object' && input !== null && 'url' in input
      ? `${String('method' in input ? input.method : '')} ${String(input.url)}`
      : ''
  })

const CANDIDATES = [
  ['Pickwell', 'pickwell.example'],
  ['Boxbot Systems', 'boxbot.example'],
  ['Tote Runner', 'tote-runner.example'],
  ['ShelfSense', 'shelfsense.example'],
  ['Gantry Labs', 'gantrylabs.example'],
  ['PalletPilot', 'palletpilot.example'],
]

describe('the first run, against the cassette', () => {
  const firstRun = async () => {
    const ports = watchPortsFor([
      replay('webset created'),
      replay('seven items'),
      replay('no more items'),
    ])
    return { ports, exit: await run(ports) }
  }

  it('creates one webset from the brief, pages it and stores its id with the cursor', async () => {
    const { ports, exit } = await firstRun()
    expect(stateOf(exit)).toEqual({
      websetId: WEBSET_ID,
      cursor: 'witem_01k79q3a07',
      lastItemId: null,
    })
    expect(requests(ports)).toEqual([
      `POST ${EXA_WEBSETS_URL}`,
      `GET ${ITEMS_URL}`,
      `GET ${NEXT_URL}`,
    ])
    expect(ports.spaces.calls.map((c) => c.input)).toEqual([SPACE_ID])
  })

  it('asks Exa for companies by the criteria, the nearest memo and the members’ domains, with the key in x-api-key', async () => {
    const { ports } = await firstRun()
    expect(ports.http.calls.at(0)?.input).toEqual({
      method: 'POST',
      url: EXA_WEBSETS_URL,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-api-key': TEST_KEY,
      },
      body: {
        search: {
          query: [
            `Companies matching: ${CRITERIA}`,
            'Thesis — Why warehouse picking: Labour is the constraint in fulfilment. Picking arms that learn a SKU fast win.',
            'Similar to: northwind-robotics.example, harborlift.example',
          ].join('\n'),
          count: 10,
          entity: { type: 'company' },
          criteria: [{ description: CRITERIA }],
        },
        externalId: WATCH_ID,
      },
    })
    expect(ports.http.calls.at(1)?.input).toEqual({
      method: 'GET',
      url: ITEMS_URL,
      headers: { accept: 'application/json', 'x-api-key': TEST_KEY },
    })
  })

  it('makes the member’s item one signal citing the hit, and hands the six others to Discover with their pages as evidence', async () => {
    const { ports } = await firstRun()
    expect(ports.content.signals).toEqual([
      {
        _tag: 'signal',
        entityId: northwind.entityId,
        kind: 'web',
        key: 'web:https://www.northwind-robotics.example/',
        url: 'https://www.northwind-robotics.example/',
        title:
          'Northwind Robotics makes picking arms that learn a new SKU from a single demonstration.',
        receiptId: 'receipt-2',
        payload: {
          websetId: WEBSET_ID,
          exaItemId: itemId(2),
          evidence: [
            {
              url: 'https://www.northwind-robotics.example/',
              title: 'Northwind Robotics',
            },
            {
              url: 'https://news.example/2026/09/northwind-robotics-series-a',
              title:
                'Northwind Robotics raises $6.5M to teach warehouse robots new SKUs',
            },
          ],
        },
      },
    ])
    expect(ports.discover.calls.map((c) => [c.name, c.domain])).toEqual(
      CANDIDATES,
    )
    expect(ports.discover.calls.at(0)).toEqual({
      spaceId: SPACE_ID,
      name: 'Pickwell',
      domain: 'pickwell.example',
      evidence: [
        { url: 'https://pickwell.example', title: 'Pickwell' },
        {
          url: 'https://news.example/2026/08/pickwell-seed',
          title: 'Pickwell raises a seed round for retrofit picking arms',
        },
      ],
    })
    expect(
      ports.discover.calls.some(
        (c) => c.domain === 'northwind-robotics.example',
      ),
    ).toBe(false)
  })

  it('keeps every answer Exa gave as a receipt on the space, whole', async () => {
    const { ports } = await firstRun()
    expect(ports.receipts.calls.map((c) => c.input)).toEqual(
      [
        'webset-create.json',
        'webset-items.json',
        'webset-items-empty.json',
      ].map((file) => ({
        entityId: SPACE_ID,
        raw: JSON.parse(fixtureText(file)),
      })),
    )
  })

  it('logs what the run did', async () => {
    const { ports } = await firstRun()
    expect(ports.log.lines).toEqual([
      {
        level: 'info',
        message: 'watch run',
        fields: {
          watchId: WATCH_ID,
          created: true,
          websetId: WEBSET_ID,
          cursor: 'witem_01k79q3a07',
          lastItemId: null,
          signals: 1,
          candidates: 6,
        },
      },
    ])
  })
})

describe('later runs', () => {
  it('page from the stored cursor and create no second webset', async () => {
    const ports = watchPortsFor([
      replay('webset created'),
      replay('seven items'),
      replay('no more items', { repeat: true }),
    ])
    const first = stateOf(await run(ports))
    const second = stateOf(await run(ports, { state: first }))
    expect(second).toEqual(first)
    expect(requests(ports)).toEqual([
      `POST ${EXA_WEBSETS_URL}`,
      `GET ${ITEMS_URL}`,
      `GET ${NEXT_URL}`,
      `GET ${NEXT_URL}`,
    ])
    expect(ports.content.signals).toHaveLength(1)
    expect(ports.discover.calls).toHaveLength(6)
  })

  it('a webset Exa has added nothing to writes nothing', async () => {
    const ports = watchPortsFor([replay('no more items')])
    const state = {
      websetId: WEBSET_ID,
      cursor: 'witem_01k79q3a07',
      lastItemId: null,
    }
    expect(stateOf(await run(ports, { state }))).toEqual(state)
    expect(ports.content.calls).toEqual([])
    expect(ports.discover.calls).toEqual([])
    expect(ports.receipts.calls).toHaveLength(1)
  })

  it('an unreadable state fails before Exa is asked anything', async () => {
    const ports = watchPortsFor([replay('webset created')])
    const failure = failureOf(await run(ports, { state: { websetId: 7 } }))
    expect(failure).toContain(
      `watch ${WATCH_ID}'s state returned a body this plugin cannot read`,
    )
    expect(ports.http.calls).toEqual([])
  })
})

describe('the cap', () => {
  it('stops the run at the configured count with the cursor saved, and the next run takes up where it stopped', async () => {
    const ports = watchPortsFor([
      replay('webset created'),
      replay('seven items', { repeat: true }),
      replay('no more items'),
    ])
    const settings = { cap: 3 }

    const first = stateOf(await run(ports, { settings }))
    expect(first).toEqual({
      websetId: WEBSET_ID,
      cursor: null,
      lastItemId: itemId(3),
    })
    expect(requests(ports)).toEqual([
      `POST ${EXA_WEBSETS_URL}`,
      `GET ${ITEMS_URL}`,
    ])
    expect(ports.discover.calls.map((c) => c.domain)).toEqual([
      'pickwell.example',
      'boxbot.example',
    ])
    expect(ports.content.signals).toHaveLength(1)

    const second = stateOf(await run(ports, { settings, state: first }))
    expect(second).toEqual({
      websetId: WEBSET_ID,
      cursor: null,
      lastItemId: itemId(6),
    })
    expect(ports.discover.calls.map((c) => c.domain).slice(2)).toEqual([
      'tote-runner.example',
      'shelfsense.example',
      'gantrylabs.example',
    ])

    const third = stateOf(await run(ports, { settings, state: second }))
    expect(third).toEqual({
      websetId: WEBSET_ID,
      cursor: 'witem_01k79q3a07',
      lastItemId: null,
    })
    expect(ports.discover.calls.map((c) => c.domain).at(-1)).toBe(
      'palletpilot.example',
    )
    expect(requests(ports).filter((r) => r.startsWith('POST'))).toHaveLength(1)
    expect(ports.discover.calls).toHaveLength(6)
    expect(ports.content.signals).toHaveLength(1)
  })

  it('sizes the webset to one run', async () => {
    const ports = watchPortsFor([
      replay('webset created'),
      replay('no more items'),
    ])
    await run(ports, { settings: { cap: 25 } })
    expect(ports.http.calls.at(0)?.input).toMatchObject({
      body: { search: { count: 25 } },
    })
  })

  it('settings that do not parse fail before Exa is asked anything', async () => {
    const ports = watchPortsFor([replay('webset created')])
    const failure = failureOf(await run(ports, { settings: { cap: 0 } }))
    expect(failure).toContain(`watch ${WATCH_ID}'s settings do not match`)
    expect(ports.http.calls).toEqual([])
  })
})

describe('what the webset looks for', () => {
  const bodyOf = async (
    settings: JsonObject,
    of: typeof brief = brief,
  ): Promise<unknown> => {
    const ports = watchPortsFor([replay('webset created')], { briefs: [of] })
    await run(ports, { settings })
    return ports.http.calls.at(0)?.input
  }

  it('is the watch’s own criteria when it has them', async () => {
    expect(
      await bodyOf({ criteria: '  Autonomous forklift makers in Europe.  ' }),
    ).toMatchObject({
      body: {
        search: {
          query: expect.stringMatching(
            /^Companies matching: Autonomous forklift makers in Europe\.\n/,
          ),
          criteria: [{ description: 'Autonomous forklift makers in Europe.' }],
        },
      },
    })
  })

  it('is the space’s path, with no criteria for Exa to check, when neither the watch nor the space has any', async () => {
    const bare = {
      ...brief,
      space: { ...brief.space, criteria: null },
      memos: [],
      members: [],
    }
    expect(await bodyOf({ criteria: ' ' }, bare)).toMatchObject({
      body: {
        search: {
          query: 'Companies that belong in Robotics › Warehouse robotics',
          count: 10,
          entity: { type: 'company' },
        },
      },
    })
    expect(JSON.stringify(await bodyOf({}, bare))).not.toContain('criteria')
  })
})

describe('the watch, when it cannot', () => {
  it('fails with Exa’s own sentence when the webset cannot be created, having written nothing', async () => {
    const ports = watchPortsFor([replay('webset create, revoked key')])
    const failure = failureOf(await run(ports))
    expect(failure).toContain('JobPermanent')
    expect(failure).toContain(
      'Exa webset create answered 401: Invalid API key. Check the key in your Exa dashboard and try again.',
    )
    expect(failure).not.toContain(TEST_KEY)
    expect(ports.receipts.calls).toEqual([])
    expect(ports.content.calls).toEqual([])
    expect(ports.discover.calls).toEqual([])
  })

  it('fails with Exa’s own sentence when a page is refused, the cursor left as it was', async () => {
    const ports = watchPortsFor([replay('webset items, out of credits')])
    const failure = failureOf(
      await run(ports, {
        state: { websetId: WEBSET_ID, cursor: null, lastItemId: null },
      }),
    )
    expect(failure).toContain(
      'Exa webset items answered 402: You have run out of credits. Add credits at dashboard.exa.ai to keep searching.',
    )
    expect(ports.discover.calls).toEqual([])
  })

  it('retries a 5xx, carrying what Exa said', async () => {
    const ports = watchPortsFor([
      {
        method: 'POST',
        url: EXA_WEBSETS_URL,
        response: { status: 503, body: { error: 'Websets are down' } },
      },
    ])
    const failure = failureOf(await run(ports))
    expect(failure).toContain('JobRetryable')
    expect(failure).toContain(
      'Exa webset create answered 503: Websets are down',
    )
  })

  it('adopts the webset a failed run created rather than creating a second', async () => {
    const ports = watchPortsFor([
      {
        method: 'POST',
        url: EXA_WEBSETS_URL,
        response: {
          status: 409,
          body: { error: 'A webset with this externalId already exists' },
        },
      },
      {
        method: 'GET',
        url: websetUrl(WATCH_ID),
        response: { body: fixtureText('webset-create.json') },
      },
      replay('seven items'),
      replay('no more items'),
    ])
    expect(stateOf(await run(ports))).toEqual({
      websetId: WEBSET_ID,
      cursor: 'witem_01k79q3a07',
      lastItemId: null,
    })
    expect(requests(ports)).toEqual([
      `POST ${EXA_WEBSETS_URL}`,
      `GET ${EXA_WEBSETS_URL}/${WATCH_ID}`,
      `GET ${ITEMS_URL}`,
      `GET ${NEXT_URL}`,
    ])
  })

  it('a page that is not webset items is permanent', async () => {
    const ports = watchPortsFor([
      { method: 'GET', url: ITEMS_URL, response: { body: { ok: 1 } } },
    ])
    const failure = failureOf(
      await run(ports, {
        state: { websetId: WEBSET_ID, cursor: null, lastItemId: null },
      }),
    )
    expect(failure).toContain(
      'Exa webset items returned a body this plugin cannot read',
    )
  })

  it('a space the host will not hand over fails before Exa is asked anything', async () => {
    const ports = watchPortsFor([replay('webset created')])
    const failure = failureOf(await run(ports, { spaceId: 'space-sensitive' }))
    expect(failure).toContain('Spaces.brief: no space space-sensitive')
    expect(ports.http.calls).toEqual([])
  })
})
