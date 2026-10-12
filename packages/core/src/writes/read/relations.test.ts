import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '../entities/resolve'
import {
  createObjectProgram,
  createRecordProgram,
} from '../attributes/object-registry'
import { objectIdForKindAsync } from '../attributes/objects'
import { createRelationshipProgram } from '../attributes/relationship'
import { updateAttributeProgram } from '../attributes/update'
import { setValues } from '../attributes/values'
import { getRecordProgram } from './record'
import { recordRelationsProgram, relationsProgram } from './relations'
import type { RelationHalf } from './relations'

/** The inverse resolver reads both halves of a relationship from its links. (D69) */

const actor = { type: 'user', id: FIXTURE_ACTOR.id } as const
const tag = () => randomUUID().slice(0, 8)

const born = async (kind: 'company' | 'person', name: string) => {
  const out = await resolveEntity({
    kind,
    name: `${name} ${tag()}`,
    source: { class: 'manual' },
  })
  const row = (
    await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, out.entityId))
  ).at(0)
  return { id: out.entityId, name: row?.name ?? '' }
}

const half = (
  halves: ReadonlyArray<RelationHalf>,
  slug: string,
): RelationHalf | undefined => halves.find((h) => h.slug === slug)

const ids = (h: RelationHalf | undefined) => h?.items.map((i) => i.id) ?? []

describe('relationsProgram', () => {
  it('reads Team on the company and Companies on the person from the same links', async () => {
    const halcyon = await born('company', 'Halcyon')
    const ada = await born('person', 'Ada')
    const bo = await born('person', 'Bo')
    await setValues({
      entityId: ada.id,
      patch: { companies: [halcyon.id] },
      actor,
    })
    await setValues({
      entityId: bo.id,
      patch: { companies: [halcyon.id] },
      actor,
    })

    const all = await Effect.runPromise(
      relationsProgram([halcyon.id, ada.id, bo.id]),
    )
    const team = half(all.get(halcyon.id) ?? [], 'team')
    expect(team).toMatchObject({
      name: 'Team',
      derived: true,
      linkSlug: 'companies',
    })
    expect(ids(team).sort()).toEqual([ada.id, bo.id].sort())
    expect(team?.value).toEqual(ids(team))
    for (const p of [ada, bo]) {
      const companies = half(all.get(p.id) ?? [], 'companies')
      expect(companies).toMatchObject({ derived: false, value: [halcyon.id] })
      expect(companies?.items).toEqual([
        {
          id: halcyon.id,
          name: halcyon.name,
          kind: 'company',
          objectSlug: 'companies',
        },
      ])
    }
  })

  it('is one statement for any number of records and attributes', async () => {
    const co = await born('company', 'Onestatement')
    const people = await Promise.all([born('person', 'P'), born('person', 'Q')])
    for (const p of people)
      await setValues({
        entityId: p.id,
        patch: { companies: [co.id] },
        actor,
      })
    const spy = vi.spyOn(db, 'execute')
    try {
      await Effect.runPromise(
        relationsProgram([co.id, ...people.map((p) => p.id)]),
      )
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("keeps the owner's order on the owning half", async () => {
    const a = await born('company', 'Zeta')
    const b = await born('company', 'Alpha')
    const p = await born('person', 'Ordered')
    await setValues({
      entityId: p.id,
      patch: { companies: [a.id, b.id] },
      actor,
    })
    const companies = half(
      await Effect.runPromise(recordRelationsProgram(p.id)),
      'companies',
    )
    expect(ids(companies)).toEqual([a.id, b.id])
  })

  it('reads a custom pair from either side, and nothing once the owner is archived', async () => {
    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: `Funds ${tag()}`,
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    const companies = { id: await objectIdForKindAsync('company') }
    const pair = await Effect.runPromise(
      createRelationshipProgram({
        objectId: funds.id,
        name: 'Portfolio',
        targetObjectId: companies.id,
        inverseName: 'Funds',
        cardinality: 'N:N',
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    const fund = (
      await Effect.runPromise(
        createRecordProgram({
          objectId: funds.id,
          name: `Fund One ${tag()}`,
          actor,
          source: 'manual',
        }),
      )
    ).id
    const co = await born('company', 'Held')
    await setValues({
      entityId: fund,
      patch: { [pair.a.slug]: [co.id] },
      actor,
    })

    const both = await Effect.runPromise(relationsProgram([fund, co.id]))
    expect(ids(half(both.get(fund) ?? [], pair.a.slug))).toEqual([co.id])
    const inverse = half(both.get(co.id) ?? [], pair.b.slug)
    expect(inverse).toMatchObject({ name: 'Funds', derived: true })
    expect(inverse?.items.at(0)?.objectSlug).toBe(funds.slug)

    await Effect.runPromise(
      updateAttributeProgram({ id: pair.a.id, archived: true }),
    )
    const after = await Effect.runPromise(recordRelationsProgram(co.id))
    expect(half(after, pair.b.slug)).toBeUndefined()
  })

  it('get_record lists the inverse half under its own slug, marked derived', async () => {
    const co = await born('company', 'Recorded')
    const p = await born('person', 'Member')
    await setValues({ entityId: p.id, patch: { companies: [co.id] }, actor })
    const rec = await Effect.runPromise(
      getRecordProgram({ id: FIXTURE_ACTOR.id }, co.id),
    )
    expect(rec.attributes.find((a) => a.slug === 'team')).toEqual({
      slug: 'team',
      name: 'Team',
      type: 'record_reference',
      value: [p.id],
      text: `Team: ${p.name}`,
      derived: true,
    })
    const owner = (
      await Effect.runPromise(getRecordProgram({ id: FIXTURE_ACTOR.id }, p.id))
    ).attributes.find((a) => a.slug === 'companies')
    expect(owner).toMatchObject({ value: [co.id] })
    expect(owner).not.toHaveProperty('derived')
  })
})
