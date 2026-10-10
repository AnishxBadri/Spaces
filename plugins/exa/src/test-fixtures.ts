import { readFileSync, readdirSync } from 'node:fs'
import { Clock, Effect, Layer } from 'effect'
import { z } from 'zod'
import { Discover } from '@spaces/sdk'
import { normalizeDomain } from '@spaces/sdk/identity'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import type { HttpScript } from '@spaces/sdk/testing'
import type {
  DiscoverClaim,
  JsonObject,
  ReadEntity,
  SpaceBrief,
} from '@spaces/sdk'
import { EXA_SEARCH_URL } from './map.ts'
import { EXA_WEBSETS_URL } from './webset.ts'

/** The committed Exa responses under fixtures/, for the tests. */
export const FIXTURES_DIR = new URL('../fixtures/', import.meta.url)

export const fixtureNames = (): ReadonlyArray<string> =>
  readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))

export const fixtureText = (name: string): string =>
  readFileSync(new URL(name, FIXTURES_DIR), 'utf8')

/**
 * The cassette: Exa's answer to each call the tests make, by name — a POST
 * to search, a POST creating a webset, a GET of a webset's items. The key
 * is never recorded.
 */
export const cassette = z
  .object({
    keyHeader: z.literal('x-api-key'),
    interactions: z.array(
      z.object({
        name: z.string(),
        method: z.enum(['GET', 'POST']),
        url: z
          .string()
          .refine(
            (url) => url === EXA_SEARCH_URL || url.startsWith(EXA_WEBSETS_URL),
          ),
        status: z.int(),
        file: z.string(),
      }),
    ),
  })
  .parse(JSON.parse(fixtureText('cassette.json')))

/** The cassette's answer named `name`, as an HttpTest script line. */
export const replay = (
  name: string,
  options: { readonly repeat?: boolean } = {},
): HttpScript => {
  const interaction = cassette.interactions.find((i) => i.name === name)
  if (interaction === undefined) throw new Error(`no interaction ${name}`)
  return {
    method: interaction.method,
    url: interaction.url,
    ...(options.repeat === true ? { repeat: true } : {}),
    response: {
      status: interaction.status,
      body: fixtureText(interaction.file),
    },
  }
}

/** Not a key: the Secrets port hands the job this, and nothing checks it. */
export const TEST_KEY = 'test-exa-key'

/** 2026-10-10T00:00:00Z — the instant every test run reads. */
export const NOW_MS = Date.UTC(2026, 9, 10)

export const company = readEntity({
  id: 'entity-0',
  name: 'Northwind Robotics',
  keys: { domain: ['northwind-robotics.example'], email: [], linkedin: [] },
})

export const BRIEF =
  'Northwind Robotics raised a $6.5M Series A [event:hit-1] and is hiring a manipulation team [event:hit-3].'

/** The test ports for one run against `http`, with the key, the record and a scripted brief. */
export const portsFor = (
  http: ReadonlyArray<HttpScript>,
  more: {
    readonly secret?: string | null
    readonly config?: JsonObject
    readonly entities?: ReadonlyArray<ReadEntity>
  } = {},
) =>
  testPorts({
    ...(more.secret === null ? {} : { secret: more.secret ?? TEST_KEY }),
    entities: more.entities ?? [company],
    ...(more.config === undefined ? {} : { config: more.config }),
    ai: { synthesize: { text: BRIEF } },
    http,
  })

/** A clock stopped at `NOW_MS`, so the lookback date is the same every run. */
export const fixedClock = Layer.succeed(Clock.Clock, {
  currentTimeMillisUnsafe: () => NOW_MS,
  currentTimeMillis: Effect.succeed(NOW_MS),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  currentTimeNanosUnsafe: () => BigInt(NOW_MS) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(NOW_MS) * 1_000_000n),
  sleep: () => Effect.void,
})

// ---------------------------------------------------------------------------
// The watch
// ---------------------------------------------------------------------------

export const SPACE_ID = 'space-0'
export const WATCH_ID = 'watch-1'

export const CRITERIA =
  'Companies building robots that pick, pack or move goods inside warehouses. Seed to Series B.'

/** The member Exa's items name once: Northwind, filed under the subject. */
export const northwind = {
  entityId: 'entity-0',
  name: 'Northwind Robotics',
  spaceId: SPACE_ID,
  domains: ['northwind-robotics.example'],
  values: { stage: 'Series A' },
}

/** Warehouse robotics, under Robotics, with a memo, two members and a leaf. */
export const brief: SpaceBrief = {
  space: { id: SPACE_ID, name: 'Warehouse robotics', criteria: CRITERIA },
  path: [
    { id: 'space-root', name: 'Robotics' },
    { id: SPACE_ID, name: 'Warehouse robotics' },
  ],
  memos: [
    {
      ref: 'note:note-root',
      spaceId: 'space-root',
      title: 'Robotics thesis',
      body: 'Hardware with software margins.',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    {
      ref: 'note:note-0',
      spaceId: SPACE_ID,
      title: 'Why warehouse picking',
      body: 'Labour is the constraint in fulfilment.\n\nPicking arms that learn a SKU fast win.',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  terms: [],
  members: [
    northwind,
    {
      entityId: 'entity-1',
      name: 'Harbor Lift',
      spaceId: 'space-leaf',
      domains: ['harborlift.example'],
      values: {},
    },
  ],
  memberCount: 2,
  tree: {
    id: SPACE_ID,
    name: 'Warehouse robotics',
    companies: 1,
    children: [
      { id: 'space-leaf', name: 'Pallet movers', companies: 1, children: [] },
    ],
  },
}

/**
 * Discover as the host answers it: null for a member's domain (dropped),
 * else a card, the same card again for a domain already proposed.
 */
export const DiscoverTest = (members: ReadonlyArray<string>) => {
  const calls: Array<DiscoverClaim> = []
  const cards = new Map<string, string>()
  const held = new Set(members.map((d) => normalizeDomain(d) ?? d))
  const layer = Layer.succeed(Discover, {
    candidate: (claim) =>
      Effect.sync(() => {
        calls.push(claim)
        const domain = normalizeDomain(claim.domain) ?? claim.domain
        if (held.has(domain)) return { suggestionId: null }
        const card = cards.get(domain) ?? `suggestion-${cards.size + 1}`
        cards.set(domain, card)
        return { suggestionId: card }
      }),
  })
  return { layer, calls }
}

/** The test ports for one watch run against `http`, Discover included. */
export const watchPortsFor = (
  http: ReadonlyArray<HttpScript>,
  more: { readonly briefs?: ReadonlyArray<SpaceBrief> } = {},
) => {
  const briefs = more.briefs ?? [brief]
  const ports = testPorts({ secret: TEST_KEY, briefs, http })
  const discover = DiscoverTest(
    briefs.flatMap((b) => b.members.flatMap((m) => m.domains)),
  )
  return {
    ...ports,
    discover,
    layer: Layer.merge(ports.layer, discover.layer),
  }
}
