import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import type { Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { ReadLive } from '@spaces/core/writes/ports/read'
import { Read } from '@spaces/sdk'
import type { RecordKind, SearchOptions } from '@spaces/sdk'
import { normalizeDomain, normalizeEmail } from '@spaces/sdk/identity'
import { ReadTest, readEntity } from '@spaces/sdk/testing'
import { insertRow, runOn } from './support'

/**
 * The Read port's contract, over every implementation: a record by id with
 * its kind, name and normalized keys; null for an id it cannot read; search
 * by name, case-insensitive, filtered by kind and capped by `limit`.
 */

type Seed = {
  readonly kind: Extract<RecordKind, 'company' | 'person'>
  readonly name: string
  readonly domain?: string
  readonly email?: string
}

const WORLD: ReadonlyArray<Seed> = [
  {
    kind: 'company',
    name: 'Northwind Robotics',
    domain: 'https://www.Northwind-Robotics.example/',
  },
  { kind: 'company', name: 'Contoso Robotics', domain: 'contoso.example' },
  {
    kind: 'person',
    name: 'Meera Kulkarni',
    email: 'Meera@Northwind-Robotics.example',
  },
]

type ReadImplementation = {
  readonly name: string
  readonly make: (world: ReadonlyArray<Seed>) => Promise<{
    readonly layer: Layer.Layer<Read>
    readonly idOf: (name: string) => string
    /** An id shaped like this implementation's, naming nothing. */
    readonly unknownId: string
  }>
}

/** The key as the choke point stores it, by the SDK's own normalizers. */
const normalized = (
  raw: string | undefined,
  normalize: (raw: string) => string | null,
): ReadonlyArray<string> => {
  const norm = raw === undefined ? null : normalize(raw)
  return norm === null ? [] : [norm]
}

const lookup = (ids: ReadonlyMap<string, string>) => (name: string) => {
  const id = ids.get(name)
  if (id === undefined) throw new Error(`no seeded record ${name}`)
  return id
}

const IMPLEMENTATIONS: ReadonlyArray<ReadImplementation> = [
  {
    name: 'ReadLive',
    make: async (world) => {
      const ids = new Map<string, string>()
      for (const seed of world) {
        const { entityId } = await resolveEntity({
          kind: seed.kind,
          name: seed.name,
          keys: {
            ...(seed.domain === undefined ? {} : { domain: seed.domain }),
            ...(seed.email === undefined ? {} : { email: seed.email }),
          },
          source: { class: 'manual' },
        })
        ids.set(seed.name, entityId)
      }
      return {
        layer: ReadLive(await insertRow()),
        idOf: lookup(ids),
        unknownId: randomUUID(),
      }
    },
  },
  {
    name: 'ReadTest',
    make: (world) => {
      const ids = new Map<string, string>()
      const entities = world.map((seed, i) => {
        const id = `entity-${i + 1}`
        ids.set(seed.name, id)
        return readEntity({
          id,
          kind: seed.kind,
          name: seed.name,
          keys: {
            domain: normalized(seed.domain, normalizeDomain),
            email: normalized(seed.email, normalizeEmail),
            linkedin: [],
          },
        })
      })
      return Promise.resolve({
        layer: ReadTest({ entities }).layer,
        idOf: lookup(ids),
        unknownId: 'entity-404',
      })
    },
  },
]

const entity = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* Read).entity(id)
  })

const search = (query: string, options?: SearchOptions) =>
  Effect.gen(function* () {
    return (yield* (yield* Read).search(query, options)).map((h) => h.name)
  })

describe.each(IMPLEMENTATIONS)('Read — $name', (impl) => {
  it('reads a company with its kind, its name and its domain normalized', async () => {
    const { layer, idOf } = await impl.make(WORLD)
    const company = await runOn(layer, entity(idOf('Northwind Robotics')))
    expect(company).toMatchObject({
      id: idOf('Northwind Robotics'),
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: ['northwind-robotics.example'], email: [] },
    })
  })

  it('reads a person with the email it is known by, lower-cased', async () => {
    const { layer, idOf } = await impl.make(WORLD)
    expect(await runOn(layer, entity(idOf('Meera Kulkarni')))).toMatchObject({
      kind: 'person',
      keys: { email: ['meera@northwind-robotics.example'] },
    })
  })

  it('answers null for an id it cannot read', async () => {
    const { layer, unknownId } = await impl.make(WORLD)
    expect(await runOn(layer, entity(unknownId))).toBeNull()
  })

  it('searches names case-insensitively', async () => {
    const { layer } = await impl.make(WORLD)
    expect(await runOn(layer, search('NORTHWIND'))).toEqual([
      'Northwind Robotics',
    ])
    expect((await runOn(layer, search('robotics'))).sort()).toEqual([
      'Contoso Robotics',
      'Northwind Robotics',
    ])
  })

  it('filters by kind and caps at the limit', async () => {
    const { layer } = await impl.make(WORLD)
    expect(await runOn(layer, search('meera', { kinds: ['person'] }))).toEqual([
      'Meera Kulkarni',
    ])
    expect(await runOn(layer, search('meera', { kinds: ['company'] }))).toEqual(
      [],
    )
    expect(await runOn(layer, search('robotics', { limit: 1 }))).toHaveLength(1)
  })
})
