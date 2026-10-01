import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { entity, link, note } from '@spaces/db/schema'
import { Read } from '@spaces/sdk'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '../entities/resolve'
import { ReadLive, actorOf } from './read'

/**
 * ReadLive against the test database (sdk-6b): the plugin's reads, as the
 * bound integration. The integration row's id is all the Layer is given —
 * these tests never insert one, because the reader is derived from the id
 * and nothing is looked up by it.
 */

const row = { id: crypto.randomUUID() }

const read = <TValue>(
  program: (port: Read['Service']) => Effect.Effect<TValue, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* program(yield* Read)
    }).pipe(Effect.provide(ReadLive(row))),
  )

const SECRET_BODY = 'Partner-only: the founders are talking to Sequoia.'

/** A company with a domain and a name alias, and a private note on it. */
const seed = async () => {
  const company = await resolveEntity({
    kind: 'company',
    name: 'Northwind Robotics',
    keys: { domain: 'https://www.northwind-robotics.example/about' },
    source: { class: 'manual' },
  })
  const privateNote = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: 'Northwind diligence' })
      .returning({ id: entity.id })
  ).at(0)
  if (!privateNote) throw new Error('no note')
  await db.insert(note).values({
    entityId: privateNote.id,
    title: 'Northwind diligence',
    bodyMd: SECRET_BODY,
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
  })
  await db.insert(link).values({
    fromEntityId: privateNote.id,
    toEntityId: company.entityId,
    relation: 'mentions',
  })
  return { companyId: company.entityId, noteId: privateNote.id }
}

describe('ReadLive.entity', () => {
  it('returns the record with its normalized identity keys — and no private note', async () => {
    const { companyId } = await seed()
    const record = await read((port) => port.entity(companyId))
    expect(record).toMatchObject({
      id: companyId,
      kind: 'company',
      name: 'Northwind Robotics',
      keys: {
        domain: ['northwind-robotics.example'],
        email: [],
        linkedin: [],
        cin: [],
      },
    })
    expect(JSON.stringify(record)).not.toContain('Sequoia')
  })

  it('answers null for the private note itself — as for an id that does not exist', async () => {
    const { noteId } = await seed()
    expect(await read((port) => port.entity(noteId))).toBeNull()
    expect(await read((port) => port.entity(crypto.randomUUID()))).toBeNull()
    expect(await read((port) => port.entity('not-a-uuid'))).toBeNull()
  })

  it('follows merged_into_id to the survivor', async () => {
    const { companyId } = await seed()
    const gone = (
      await db
        .insert(entity)
        .values({
          kind: 'company',
          canonicalName: 'Northwind (dup)',
          mergedIntoId: companyId,
        })
        .returning({ id: entity.id })
    ).at(0)
    if (!gone) throw new Error('no row')
    const record = await read((port) => port.entity(gone.id))
    expect(record?.id).toBe(companyId)
    expect(record?.name).toBe('Northwind Robotics')
  })

  it('carries attribute values by slug', async () => {
    const { companyId } = await seed()
    await db
      .update(entity)
      .set({ values: { location: 'Pune, India' } })
      .where(eq(entity.id, companyId))
    const record = await read((port) => port.entity(companyId))
    expect(record?.values).toMatchObject({ location: 'Pune, India' })
  })
})

describe('ReadLive.search', () => {
  it('finds a record by a fuzzy name, and never a private note', async () => {
    const { companyId, noteId } = await seed()
    const hits = await read((port) => port.search('northwnd'))
    expect(hits).toContainEqual({
      entityId: companyId,
      kind: 'company',
      name: 'Northwind Robotics',
    })
    expect(hits.map((h) => h.entityId)).not.toContain(noteId)
    // A word only the private note's body has finds nothing at all.
    expect(await read((port) => port.search('Sequoia'))).toEqual([])
  })

  it('narrows by kind and limit', async () => {
    await seed()
    expect(
      await read((port) => port.search('Northwind', { kinds: ['person'] })),
    ).toEqual([])
    expect(
      await read((port) => port.search('Northwind', { limit: 0 })),
    ).toEqual([])
  })

  it('makes no embedding call: nothing it imports reaches the AI substrate', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    for (const file of ['read.ts', '../read/search.ts', '../read/record.ts']) {
      const specifiers = [
        ...readFileSync(`${dir}${file}`, 'utf8').matchAll(
          /^import .* from '([^']+)'$/gm,
        ),
      ].map((m) => m[1])
      expect(specifiers.length).toBeGreaterThan(0)
      for (const s of specifiers) expect(s).not.toMatch(/embed|\/ai\b|^ai$/)
    }
  })
})

describe('the actor', () => {
  it('is the bound row, as an integration — and no exported function takes one', () => {
    expect(actorOf(row)).toEqual({ type: 'integration', id: row.id })
    // ReadLive's only parameter is the row; the port's methods take an id or
    // a query, never a reader.
    expect(ReadLive.length).toBe(1)
    const source = readFileSync(
      fileURLToPath(new URL('./read.ts', import.meta.url)),
      'utf8',
    )
    const exported = [
      ...source.matchAll(/^export const (\w+) = \(([^)]*)\)/gm),
    ].map((m) => [m[1], m[2]])
    expect(exported.map(([name]) => name).sort()).toEqual([
      'ReadLive',
      'actorOf',
    ])
    for (const [, params] of exported)
      expect(params).not.toMatch(/actor|reader|user/i)
  })
})
