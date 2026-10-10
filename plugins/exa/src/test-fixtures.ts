import { readFileSync, readdirSync } from 'node:fs'
import { Clock, Effect, Layer } from 'effect'
import { z } from 'zod'
import { readEntity, testPorts } from '@spaces/sdk/testing'
import type { HttpScript } from '@spaces/sdk/testing'
import type { JsonObject, ReadEntity } from '@spaces/sdk'
import { EXA_SEARCH_URL } from './map.ts'

/** The committed Exa responses under fixtures/, for the tests. */
export const FIXTURES_DIR = new URL('../fixtures/', import.meta.url)

export const fixtureNames = (): ReadonlyArray<string> =>
  readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))

export const fixtureText = (name: string): string =>
  readFileSync(new URL(name, FIXTURES_DIR), 'utf8')

/**
 * The cassette: Exa's answer to each search the tests make, by name. Every
 * interaction is a POST to the search endpoint; the key is never recorded.
 */
export const cassette = z
  .object({
    keyHeader: z.literal('x-api-key'),
    interactions: z.array(
      z.object({
        name: z.string(),
        method: z.literal('POST'),
        url: z.literal(EXA_SEARCH_URL),
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
