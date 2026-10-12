import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { attribute, attributeEvent, link, objectDef } from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import type { Condition } from '@spaces/core/views/filter'
import type { Actor } from '@spaces/core/writes/attributes/values'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { listPeoplePageProgram } from '#/lib/views/directory'
import { companyPeopleProgram, setPersonCompanyProgram } from './companies'

/**
 * A person's companies are the `companies` attribute (D60): every write goes
 * through the one write path, and every reader — the people table, the
 * company page, a saved view — reads the value or the link it materializes.
 */

const ME: Actor = { type: 'user', id: FIXTURE_ACTOR.id }

async function aCompany(name: string) {
  const tag = randomUUID().slice(0, 8)
  const c = await resolveEntity({
    kind: 'company',
    name: `${name} ${tag}`,
    keys: { domain: `${name.toLowerCase()}-${tag}.example` },
    source: { class: 'manual' },
  })
  return c.entityId
}

async function aPerson(name: string) {
  const p = await resolveEntity({
    kind: 'person',
    name,
    source: { class: 'manual' },
  })
  return p.entityId
}

const change = (
  personId: string,
  companyId: string,
  action: 'link' | 'unlink',
) =>
  Effect.runPromise(
    setPersonCompanyProgram({ personId, companyId, action, actor: ME }),
  )

async function companyLinks(personId: string) {
  return db
    .select({ to: link.toEntityId })
    .from(link)
    .where(
      and(
        eq(link.fromEntityId, personId),
        eq(link.relation, 'references'),
        eq(link.attrSlug, 'companies'),
      ),
    )
}

async function companyEvents(personId: string) {
  return db
    .select()
    .from(attributeEvent)
    .where(
      and(
        eq(attributeEvent.entityId, personId),
        eq(attributeEvent.attrSlug, 'companies'),
      ),
    )
}

describe('the companies attribute', () => {
  it('is seeded on people as a multi company reference', async () => {
    const row = (
      await db
        .select({ type: attribute.type, options: attribute.options })
        .from(attribute)
        .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
        .where(
          and(eq(objectDef.slug, 'people'), eq(attribute.slug, 'companies')),
        )
    ).at(0)
    expect(row).toEqual({
      type: 'record_reference',
      options: {
        targetKind: 'company',
        multi: true,
        enrichmentKey: 'person.company',
        // The owner of the pair a company's `team` reads. (D69)
        cardinality: 'N:N',
        inverseOf: expect.any(String),
      },
    })
  })

  it('writes each link and unlink through the one write path', async () => {
    const kalpana = await aCompany('Kalpana')
    const vayu = await aCompany('Vayu')
    const personId = await aPerson(`Rhea ${randomUUID().slice(0, 6)}`)

    await change(personId, kalpana, 'link')
    await change(personId, vayu, 'link')
    // Already held: nothing written.
    expect(await change(personId, vayu, 'link')).toBeNull()

    const events = await companyEvents(personId)
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.actorId === FIXTURE_ACTOR.id)).toBe(true)
    expect(events.map((e) => e.to)).toEqual(
      expect.arrayContaining([[kalpana], [kalpana, vayu]]),
    )
    expect((await companyLinks(personId)).map((l) => l.to).sort()).toEqual(
      [kalpana, vayu].sort(),
    )

    await change(personId, kalpana, 'unlink')
    expect(await companyEvents(personId)).toHaveLength(3)
    expect((await companyLinks(personId)).map((l) => l.to)).toEqual([vayu])

    // The last one off clears the value and its links.
    await change(personId, vayu, 'unlink')
    expect(await companyLinks(personId)).toEqual([])
  })

  it('shows a person at two companies on both company pages and in the people table', async () => {
    const kalpana = await aCompany('Kalpana')
    const vayu = await aCompany('Vayu')
    const tag = randomUUID().slice(0, 8)
    const personId = await aPerson(`Angel ${tag}`)
    await change(personId, kalpana, 'link')
    await change(personId, vayu, 'link')

    for (const companyId of [kalpana, vayu]) {
      const people = await Effect.runPromise(companyPeopleProgram(companyId))
      expect(people.map((p) => p.id)).toEqual([personId])
    }

    const page = await Effect.runPromise(
      listPeoplePageProgram([], { q: tag, limit: 10 }),
    )
    const row = page.rows.find((r) => r.id === personId)
    expect(row?.values.companies).toEqual([kalpana, vayu])
    expect(page.refNames[kalpana].name).toMatch(/^Kalpana/)
    expect(page.refNames[vayu].name).toMatch(/^Vayu/)
  })

  it('filters and sorts a saved view on Companies', async () => {
    const kalpana = await aCompany('Kalpana')
    const vayu = await aCompany('Vayu')
    const tag = randomUUID().slice(0, 8)
    const atKalpana = await aPerson(`Kay ${tag}`)
    const atVayu = await aPerson(`Vee ${tag}`)
    const atBoth = await aPerson(`Bo ${tag}`)
    const nowhere = await aPerson(`Nil ${tag}`)
    await change(atKalpana, kalpana, 'link')
    await change(atVayu, vayu, 'link')
    await change(atBoth, vayu, 'link')
    await change(atBoth, kalpana, 'link')

    const at: Array<Condition> = [
      { slug: 'companies', op: 'is', value: kalpana },
    ]
    const filtered = await Effect.runPromise(
      listPeoplePageProgram(at, { q: tag, limit: 10 }),
    )
    expect(filtered.rows.map((r) => r.id).sort()).toEqual(
      [atKalpana, atBoth].sort(),
    )
    expect(filtered.total).toBe(2)

    const blank: Array<Condition> = [{ slug: 'companies', op: 'empty' }]
    const none = await Effect.runPromise(
      listPeoplePageProgram(blank, { q: tag, limit: 10 }),
    )
    expect(none.rows.map((r) => r.id)).toEqual([nowhere])

    // Sorted on the stored value, empties last: every row, people at the
    // same companies side by side.
    const sorted = await Effect.runPromise(
      listPeoplePageProgram([], {
        q: tag,
        limit: 10,
        sort: { id: 'attr:companies', desc: false },
      }),
    )
    expect(sorted.rows).toHaveLength(4)
    expect(sorted.rows.at(-1)?.id).toBe(nowhere)
  })
})
