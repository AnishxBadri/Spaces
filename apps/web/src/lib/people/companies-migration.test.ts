import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { MIGRATIONS_FOLDER } from '@spaces/db/migrate'
import { attributeEvent, entity, link } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { setValues } from '@spaces/core/writes/attributes/values'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { companyPeopleProgram } from './companies'

/**
 * The data migration that turned `link(contact_at)` into the `companies`
 * attribute. The test database is already past it, so the legacy rows
 * are written here by hand and the migration's statements are run again over
 * them — they touch `contact_at` rows and nothing else.
 */

const MIGRATION = path.join(
  MIGRATIONS_FOLDER,
  '0059_person_companies_attribute.sql',
)

async function runMigration() {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  for (const statement of statements) await db.execute(sql.raw(statement))
}

const tag = () => randomUUID().slice(0, 8)

async function aCompany(name: string) {
  const t = tag()
  return (
    await resolveEntity({
      kind: 'company',
      name: `${name} ${t}`,
      keys: { domain: `${name.toLowerCase()}-${t}.example` },
      source: { class: 'manual' },
    })
  ).entityId
}

async function aPerson(name: string) {
  return (
    await resolveEntity({
      kind: 'person',
      name: `${name} ${tag()}`,
      source: { class: 'manual' },
    })
  ).entityId
}

/** The legacy edge, as written before the migration. */
async function contactAt(personId: string, toId: string, at: string) {
  await db.insert(link).values({
    fromEntityId: personId,
    toEntityId: toId,
    relation: 'contact_at',
    source: 'manual',
    createdBy: FIXTURE_ACTOR.id,
    createdAt: new Date(at),
  })
}

async function valuesOf(id: string) {
  return (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, id))
  ).at(0)?.values
}

describe('migration 0059: contact_at becomes the companies attribute', () => {
  it('converts every contact_at link and leaves none behind', async () => {
    const kalpana = await aCompany('Kalpana')
    const vayu = await aCompany('Vayu')
    const angel = await aPerson('Angel')
    const founder = await aPerson('Founder')
    const nobody = await aPerson('Nobody')
    // Vayu first: the value keeps the order the links were made in.
    await contactAt(angel, vayu, '2026-01-01T00:00:00Z')
    await contactAt(angel, kalpana, '2026-02-01T00:00:00Z')
    await contactAt(founder, kalpana, '2026-03-01T00:00:00Z')

    // A deal an identity accept linked a person to, and one already on it.
    const [deal] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `Vayu seed ${tag()}` })
      .returning({ id: entity.id })
    const onDeal = await aPerson('On deal')
    const named = await aPerson('Named')
    await setValues({
      entityId: deal.id,
      patch: { people: [named] },
      actor: { type: 'user', id: FIXTURE_ACTOR.id },
    })
    await contactAt(onDeal, deal.id, '2026-04-01T00:00:00Z')
    await contactAt(named, deal.id, '2026-04-02T00:00:00Z')

    await runMigration()

    expect((await valuesOf(angel))?.companies).toEqual([vayu, kalpana])
    expect((await valuesOf(founder))?.companies).toEqual([kalpana])
    expect((await valuesOf(nobody))?.companies).toBeUndefined()

    // The links were rewritten, not duplicated.
    const refs = await db
      .select({ from: link.fromEntityId, to: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.relation, 'references'), eq(link.attrSlug, 'companies')),
      )
    expect(refs).toHaveLength(3)

    // History: one system event per converted person.
    const events = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, angel),
          eq(attributeEvent.attrSlug, 'companies'),
        ),
      )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorType: 'system',
      from: null,
      to: [vayu, kalpana],
    })

    // The company pages list the same people the links named.
    const atKalpana = await Effect.runPromise(companyPeopleProgram(kalpana))
    expect(atKalpana.map((p) => p.id).sort()).toEqual([angel, founder].sort())
    const atVayu = await Effect.runPromise(companyPeopleProgram(vayu))
    expect(atVayu.map((p) => p.id)).toEqual([angel])

    // The deal gained the person it lacked, once.
    expect((await valuesOf(deal.id))?.people).toEqual([named, onDeal])
    const dealRefs = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, deal.id),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'people'),
        ),
      )
    expect(dealRefs.map((l) => l.to).sort()).toEqual([named, onDeal].sort())

    const left = await db
      .select({ id: link.id })
      .from(link)
      .where(eq(link.relation, 'contact_at'))
    expect(left).toEqual([])
  })
})
