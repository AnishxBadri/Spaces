import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute, attributeEvent, entity, link } from '@spaces/db/schema'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '../entities/resolve'
import { createObjectProgram, createRecordProgram } from './object-registry'
import { objectIdForKindAsync } from './objects'
import { createRelationshipProgram } from './relationship'
import { seedSystemAttributes } from './seed'
import { updateAttributeProgram } from './update'
import { setValues, setValuesInTx } from './values'
import type { Cardinality } from '../../attributes/relationship'

/** A relationship is a pair of attributes, its value stored once on the owner. (D69) */

const actor = { type: 'user', id: FIXTURE_ACTOR.id } as const
const tag = () => randomUUID().slice(0, 8)

const born = async (kind: 'company' | 'person', name: string) =>
  (
    await resolveEntity({
      kind,
      name: `${name} ${tag()}`,
      source: { class: 'manual' },
    })
  ).entityId

const customObject = async (plural: string) =>
  Effect.runPromise(
    createObjectProgram({
      singular: plural.slice(0, -1),
      plural: `${plural} ${tag()}`,
      createdBy: FIXTURE_ACTOR.id,
    }),
  )

const record = async (objectId: string, name: string) =>
  (
    await Effect.runPromise(
      createRecordProgram({
        objectId,
        name: `${name} ${tag()}`,
        actor,
        source: 'manual',
      }),
    )
  ).id

const relate = (
  objectId: string,
  name: string,
  targetObjectId: string,
  inverseName: string,
  cardinality: Cardinality,
) =>
  Effect.runPromise(
    createRelationshipProgram({
      objectId,
      name,
      targetObjectId,
      inverseName,
      cardinality,
      createdBy: FIXTURE_ACTOR.id,
    }),
  )

const valuesOf = async (id: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values ?? {}

const attr = async (id: string) => {
  const row = (
    await db.select().from(attribute).where(eq(attribute.id, id))
  ).at(0)
  if (!row) throw new Error(`no attribute ${id}`)
  return row
}

const systemAttr = async (kind: 'company' | 'person', slug: string) => {
  const objectId = await objectIdForKindAsync(kind)
  const row = (
    await db
      .select()
      .from(attribute)
      .where(and(eq(attribute.objectId, objectId), eq(attribute.slug, slug)))
  ).at(0)
  if (!row) throw new Error(`no ${kind}.${slug}`)
  return row
}

const eventsOn = (entityId: string, slug: string) =>
  db
    .select()
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, entityId),
        eq(attributeEvent.attrSlug, slug),
      ),
    )

const refLinks = (from: string, to: string, slug: string) =>
  db
    .select()
    .from(link)
    .where(
      and(
        eq(link.fromEntityId, from),
        eq(link.toEntityId, to),
        eq(link.relation, 'references'),
        eq(link.attrSlug, slug),
      ),
    )

const refusal = async (run: Promise<unknown>) => {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  )
  return err instanceof Error ? err.message : String(err)
}

describe('the system pair: person companies ↔ company team', () => {
  it('is seeded paired, and seeding again changes nothing', async () => {
    const companies = await systemAttr('person', 'companies')
    const team = await systemAttr('company', 'team')
    expect(companies.options).toMatchObject({
      inverseOf: team.id,
      cardinality: 'N:N',
      multi: true,
    })
    expect(companies.options.derived).toBeUndefined()
    expect(team.options).toMatchObject({
      inverseOf: companies.id,
      cardinality: 'N:N',
      derived: true,
      targetKind: 'person',
    })

    const before = await db.select().from(attribute).orderBy(attribute.id)
    await seedSystemAttributes()
    const after = await db.select().from(attribute).orderBy(attribute.id)
    expect(after).toEqual(before)
  })

  it('pairs an install whose companies predates the pair', async () => {
    const companies = await systemAttr('person', 'companies')
    const team = await systemAttr('company', 'team')
    await db
      .update(attribute)
      .set({
        options: {
          targetKind: 'company',
          multi: true,
          enrichmentKey: 'person.company',
        },
      })
      .where(eq(attribute.id, companies.id))
    await db.delete(attribute).where(eq(attribute.id, team.id))

    await seedSystemAttributes()

    const team2 = await systemAttr('company', 'team')
    expect((await systemAttr('person', 'companies')).options).toMatchObject({
      inverseOf: team2.id,
      cardinality: 'N:N',
    })
    expect(team2.options.inverseOf).toBe(companies.id)
  })

  it('writes a team member as one setValues on the person', async () => {
    const company = await born('company', 'Acme')
    const elsewhere = await born('company', 'Elsewhere')
    const ada = await born('person', 'Ada')
    await setValues({ entityId: ada, patch: { companies: [elsewhere] }, actor })

    const result = await setValues({
      entityId: company,
      patch: { team: [ada] },
      actor,
    })
    expect(result.changed).toEqual(['team'])

    expect((await valuesOf(ada)).companies).toEqual([elsewhere, company])
    expect((await valuesOf(company)).team).toBeUndefined()
    expect(await eventsOn(ada, 'companies')).toHaveLength(2)
    expect(await eventsOn(company, 'team')).toHaveLength(0)
    expect(await refLinks(ada, company, 'companies')).toHaveLength(1)

    // The full set is the value: dropping Ada takes the company off her.
    await setValues({ entityId: company, patch: { team: null }, actor })
    expect((await valuesOf(ada)).companies).toEqual([elsewhere])
    expect(await refLinks(ada, company, 'companies')).toHaveLength(0)
  })
})

describe('createRelationshipProgram', () => {
  it('creates both halves in one transaction, paired', async () => {
    const funds = await customObject('Funds')
    const companiesObject = await objectIdForKindAsync('company')
    const made = await relate(
      funds.id,
      'Portfolio',
      companiesObject,
      'Funds',
      'N:N',
    )
    expect(made.owner).toBe('a')

    const a = await attr(made.a.id)
    const b = await attr(made.b.id)
    expect(a.objectId).toBe(funds.id)
    expect(a.options).toMatchObject({
      targetKind: 'company',
      multi: true,
      inverseOf: b.id,
      cardinality: 'N:N',
    })
    expect(a.options.derived).toBeUndefined()
    expect(b.objectId).toBe(companiesObject)
    expect(b.options).toMatchObject({
      targetObjectId: funds.id,
      multi: true,
      inverseOf: a.id,
      cardinality: 'N:N',
      derived: true,
    })

    // A company added from the fund's side is stored on the fund.
    const fund = await record(funds.id, 'Fund I')
    const acme = await born('company', 'Acme')
    await setValues({
      entityId: fund,
      patch: { [made.a.slug]: [acme] },
      actor,
    })
    expect((await valuesOf(fund))[made.a.slug]).toEqual([acme])
    expect(await eventsOn(fund, made.a.slug)).toHaveLength(1)

    // And from the company's side, too — on the fund, one event more.
    const fund2 = await record(funds.id, 'Fund II')
    await setValues({
      entityId: acme,
      patch: { [made.b.slug]: [fund, fund2] },
      actor,
    })
    expect((await valuesOf(fund2))[made.a.slug]).toEqual([acme])
    expect(await eventsOn(fund2, made.a.slug)).toHaveLength(1)
    expect(await eventsOn(fund, made.a.slug)).toHaveLength(1)
    expect((await valuesOf(acme))[made.b.slug]).toBeUndefined()
  })

  it('refuses a half that cannot be named, and leaves nothing behind', async () => {
    const funds = await customObject('Funds')
    const people = await objectIdForKindAsync('person')
    const err = await Effect.runPromise(
      Effect.flip(
        createRelationshipProgram({
          objectId: funds.id,
          name: 'Partners',
          targetObjectId: people,
          inverseName: '  ',
          cardinality: 'N:N',
          createdBy: FIXTURE_ACTOR.id,
        }),
      ),
    )
    expect(err._tag).toBe('RelationshipRejected')
    const rows = await db
      .select()
      .from(attribute)
      .where(eq(attribute.objectId, funds.id))
    expect(rows).toHaveLength(0)
  })
})

describe('cardinality in setValues', () => {
  it('N:1 holds one record on the owner and refuses a list', async () => {
    const rounds = await customObject('Rounds')
    const companiesObject = await objectIdForKindAsync('company')
    const made = await relate(
      rounds.id,
      'Company',
      companiesObject,
      'Rounds',
      'N:1',
    )
    expect(made.owner).toBe('a')
    const a = await attr(made.a.id)
    expect(a.options.multi).toBe(false)
    expect((await attr(made.b.id)).options).toMatchObject({
      cardinality: '1:N',
      multi: true,
      derived: true,
    })

    const round = await record(rounds.id, 'Seed')
    const acme = await born('company', 'Acme')
    const other = await born('company', 'Other')
    expect(
      await refusal(
        setValues({
          entityId: round,
          patch: { [made.a.slug]: [acme, other] },
          actor,
        }),
      ),
    ).toBe(`${made.a.slug}: Holds one record — the relationship is N:1`)

    // From the company's side, each round gains the one company.
    const round2 = await record(rounds.id, 'Series A')
    await setValues({
      entityId: acme,
      patch: { [made.b.slug]: [round, round2] },
      actor,
    })
    expect((await valuesOf(round))[made.a.slug]).toBe(acme)
    expect((await valuesOf(round2))[made.a.slug]).toBe(acme)

    // A round moving to another company leaves the first one's list.
    await setValues({
      entityId: other,
      patch: { [made.b.slug]: [round2] },
      actor,
    })
    expect((await valuesOf(round2))[made.a.slug]).toBe(other)
  })

  it('1:1 refuses a second owner, naming the record that holds it', async () => {
    const seats = await customObject('Seats')
    const people = await objectIdForKindAsync('person')
    const made = await relate(seats.id, 'Holder', people, 'Seat', '1:1')
    const s1 = await record(seats.id, 'Board seat')
    const s2 = await record(seats.id, 'Observer seat')
    const ada = await born('person', 'Ada')
    await setValues({ entityId: s1, patch: { [made.a.slug]: ada }, actor })

    const [s1Name, adaName] = await Promise.all(
      [s1, ada].map(async (id) =>
        (
          await db
            .select({ name: entity.canonicalName })
            .from(entity)
            .where(eq(entity.id, id))
        ).at(0),
      ),
    )
    expect(
      await refusal(
        setValues({ entityId: s2, patch: { [made.a.slug]: ada }, actor }),
      ),
    ).toBe(
      `${made.a.slug}: ${adaName?.name} is already held by ${s1Name?.name}`,
    )

    // From the person's side the seat moves: the old holder is cleared first.
    await setValues({ entityId: ada, patch: { [made.b.slug]: s2 }, actor })
    expect((await valuesOf(s1))[made.a.slug]).toBeUndefined()
    expect((await valuesOf(s2))[made.a.slug]).toBe(ada)
    expect(
      await refusal(
        setValues({
          entityId: ada,
          patch: { [made.b.slug]: [s1, s2] },
          actor,
        }),
      ),
    ).toBe(`${made.b.slug}: Holds one record — the relationship is 1:1`)
  })
})

describe('archiving a half detaches the pair', () => {
  const pairUp = async () => {
    const funds = await customObject('Funds')
    const companiesObject = await objectIdForKindAsync('company')
    const made = await relate(
      funds.id,
      'Portfolio',
      companiesObject,
      'Funds',
      'N:N',
    )
    return { funds, made }
  }
  const archive = (id: string) =>
    Effect.runPromise(updateAttributeProgram({ id, archived: true }))

  it('the owner first: the derived half then refuses a write, naming the pair, and archives too', async () => {
    const { made } = await pairUp()
    await archive(made.a.id)
    const acme = await born('company', 'Acme')
    expect(
      await refusal(
        setValues({ entityId: acme, patch: { [made.b.slug]: [] }, actor }),
      ),
    ).toBe(
      `${made.b.slug}: its pair Portfolio is archived — the relationship stores nothing new`,
    )
    await archive(made.b.id)
    expect((await attr(made.b.id)).archived).toBe(true)
  })

  it('the derived half first: the owner keeps its value and its writes', async () => {
    const { funds, made } = await pairUp()
    await archive(made.b.id)
    const fund = await record(funds.id, 'Fund I')
    const acme = await born('company', 'Acme')
    await setValues({ entityId: fund, patch: { [made.a.slug]: [acme] }, actor })
    expect((await valuesOf(fund))[made.a.slug]).toEqual([acme])
    await archive(made.a.id)
    expect((await attr(made.a.id)).archived).toBe(true)
  })
})

describe('inverse writes land whole', () => {
  it('a fill on an empty team adds to owners that already hold other companies', async () => {
    const acme = await born('company', 'Acme')
    const other = await born('company', 'Other')
    const p1 = await born('person', 'P1')
    const p2 = await born('person', 'P2')
    await setValues({ entityId: p1, patch: { companies: [other] }, actor })
    const result = await setValues({
      entityId: acme,
      patch: { team: [p1, p2] },
      actor: { type: 'system' },
      fillBlanks: true,
    })
    expect(result.conflicts).toEqual([])
    expect((await valuesOf(p1)).companies).toEqual([other, acme])
    expect((await valuesOf(p2)).companies).toEqual([acme])
  })

  it('a fill that would replace a single-value owner refuses whole, naming the holder', async () => {
    const rounds = await customObject('Rounds')
    const companiesObject = await objectIdForKindAsync('company')
    const made = await relate(
      rounds.id,
      'Company',
      companiesObject,
      'Rounds',
      'N:1',
    )
    const acme = await born('company', 'Acme')
    const other = await born('company', 'Other')
    const r1 = await record(rounds.id, 'Seed')
    const r2 = await record(rounds.id, 'Series A')
    await setValues({ entityId: r1, patch: { [made.a.slug]: other }, actor })
    const result = await setValues({
      entityId: acme,
      patch: { [made.b.slug]: [r1, r2] },
      actor: { type: 'system' },
      fillBlanks: true,
    })
    expect(result.conflicts).toEqual([
      {
        slug: made.b.slug,
        existing: [other],
        proposed: [r1, r2],
        reference: true,
      },
    ])
    expect(result.changed).toEqual([])
    expect((await valuesOf(r1))[made.a.slug]).toBe(other)
    expect((await valuesOf(r2))[made.a.slug]).toBeUndefined()
  })

  it('a refused step rolls every step back', async () => {
    const acme = await born('company', 'Acme')
    const p1 = await born('person', 'P1')
    const merged = await born('person', 'Gone')
    await db
      .update(entity)
      .set({ mergedIntoId: p1 })
      .where(eq(entity.id, merged))
    expect(
      await refusal(
        setValues({ entityId: acme, patch: { team: [p1, merged] }, actor }),
      ),
    ).toBe('team: Referenced record was merged')
    expect((await valuesOf(p1)).companies).toBeUndefined()
  })

  it('a repeated record is one record: no event, no change', async () => {
    const acme = await born('company', 'Acme')
    const ada = await born('person', 'Ada')
    await setValues({ entityId: acme, patch: { team: [ada] }, actor })
    const again = await setValues({
      entityId: acme,
      patch: { team: [ada, ada] },
      actor,
    })
    expect(again.changed).toEqual([])
    expect(await eventsOn(ada, 'companies')).toHaveLength(1)
    const bob = await born('person', 'Bob')
    await setValues({ entityId: acme, patch: { team: [bob, bob] }, actor })
    expect((await valuesOf(bob)).companies).toEqual([acme])
  })
})

describe('1:1 under concurrency', () => {
  it('two writers claiming one target: exactly one commits', async () => {
    const seats = await customObject('Seats')
    const people = await objectIdForKindAsync('person')
    const made = await relate(seats.id, 'Holder', people, 'Seat', '1:1')
    const s1 = await record(seats.id, 'Board seat')
    const s2 = await record(seats.id, 'Observer seat')
    const ada = await born('person', 'Ada')
    // Each transaction holds its seat's row while the other runs.
    const claim = (seat: string) =>
      db.transaction(async (tx) => {
        await setValuesInTx(tx, {
          entityId: seat,
          patch: { [made.a.slug]: ada },
          actor,
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
      })
    const results = await Promise.allSettled([claim(s1), claim(s2)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const holders = (await Promise.all([s1, s2].map(valuesOf))).filter(
      (v) => v[made.a.slug] === ada,
    )
    expect(holders).toHaveLength(1)
  })
})
