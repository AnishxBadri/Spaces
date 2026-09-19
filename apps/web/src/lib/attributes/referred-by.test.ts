import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * `deal.referred_by` (SPA-59) — the who behind the channel, beside
 * `deal.source`. It is a seeded system attribute and nothing else: no
 * column, no `ENTITY_REFS` entry, no cell type, no server fn. These tests
 * pin the two things that claim buys — the seeder stays idempotent with it
 * appended, and the existing record-reference write path materializes the
 * link that backlinks and the context assembler already read.
 */

const ASOF = '2026-09-19T00:00:00Z'

describe('deal.referred_by — seeding', () => {
  it('is appended fresh and survives a second seed with no sortOrder moved', async () => {
    const { db } = await import('@spaces/db')
    const { attribute, objectDef } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { seedSystemAttributes } = await import('./seed')
    const { SYSTEM_ATTRIBUTES } =
      await import('@spaces/core/attributes/registry')

    /** Every seeded attribute's sortOrder, keyed by object slug + attr slug. */
    const sortOrders = async () => {
      const rows = await db
        .select({
          object: objectDef.slug,
          slug: attribute.slug,
          sortOrder: attribute.sortOrder,
        })
        .from(attribute)
        .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
      return Object.fromEntries(
        rows.map((r) => [`${r.object}.${r.slug}`, r.sortOrder]),
      )
    }

    // The per-file harness truncates `public` and seeds — this *is* the
    // fresh boot, before anything in this file has run.
    const fresh = await sortOrders()
    expect(fresh).toHaveProperty('deals.referred_by')
    // Appended, so its sortOrder is the array's length × 10 and no earlier
    // attribute's index — close_reason's least of all — has shifted.
    expect(fresh['deals.referred_by']).toBe(SYSTEM_ATTRIBUTES.deal.length * 10)
    expect(fresh['deals.close_reason']).toBe(
      SYSTEM_ATTRIBUTES.deal.length * 10 - 10,
    )

    // Second seed against the already-seeded database: insert-if-absent, so
    // nothing is inserted and nothing is rewritten.
    await seedSystemAttributes()
    expect(await sortOrders()).toEqual(fresh)

    const dealObject = (
      await db
        .select({ id: objectDef.id })
        .from(objectDef)
        .where(eq(objectDef.slug, 'deals'))
    ).at(0)
    expect(dealObject).toBeTruthy()
    const rows = await db
      .select()
      .from(attribute)
      .where(
        and(
          eq(attribute.objectId, dealObject!.id),
          eq(attribute.slug, 'referred_by'),
        ),
      )
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Referred by')
    expect(rows[0].type).toBe('record_reference')
    expect(rows[0].isSystem).toBe(true)
    expect(rows[0].options).toEqual({ targetKind: 'person', multi: false })
  })
})

describe('deal.referred_by — the write path', () => {
  it('writes the uuid into values and exactly one references link; clearing removes it', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues, AttributeValidationError } = await import('./values')
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const person = await resolveEntity({
      kind: 'person',
      name: `Referrer ${tag}`,
      keys: { email: `referrer-${tag}@example.test` },
      source: { class: 'manual' },
    })
    const company = await resolveEntity({
      kind: 'company',
      name: `RefCo ${tag}`,
      keys: { domain: `refco-${tag}.com` },
      source: { class: 'manual' },
    })
    const [dealEnt] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `RefDeal ${tag}` })
      .returning({ id: entity.id })

    // The channel and the who, in one patch.
    await setValues({
      entityId: dealEnt.id,
      patch: { source: 'referral', referred_by: person.entityId },
      actor: { type: 'user', id: actor.id },
    })

    const refLinks = () =>
      db
        .select()
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, dealEnt.id),
            eq(link.relation, 'references'),
            eq(link.attrSlug, 'referred_by'),
          ),
        )

    const [set] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, dealEnt.id))
    expect(set.values.referred_by).toBe(person.entityId)
    expect(set.values.source).toBe('referral')

    const links = await refLinks()
    expect(links.length).toBe(1)
    expect(links[0].toEntityId).toBe(person.entityId)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, dealEnt.id),
          eq(attributeEvent.attrSlug, 'referred_by'),
        ),
      )
    expect(events.length).toBe(1)
    expect(events[0].to).toBe(person.entityId)

    // targetKind is enforced by the shared write path, not by a new picker.
    await expect(
      setValues({
        entityId: dealEnt.id,
        patch: { referred_by: company.entityId },
        actor: { type: 'user', id: actor.id },
      }),
    ).rejects.toThrow(AttributeValidationError)

    // Clearing drops the value and the link together.
    await setValues({
      entityId: dealEnt.id,
      patch: { referred_by: null },
      actor: { type: 'user', id: actor.id },
    })
    const [cleared] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, dealEnt.id))
    expect(cleared.values.referred_by).toBeUndefined()
    expect(await refLinks()).toEqual([])
  })
})

describe('deal.referred_by — backlinks', () => {
  it('puts the deal on the referrer through the existing backlink path', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { setValues } = await import('./values')
    const { assembleProgram } = await import('#/lib/context/assemble')
    const { Effect } = await import('effect')
    const { db } = await import('@spaces/db')
    const { entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq, isNull } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)

    const person = await resolveEntity({
      kind: 'person',
      name: `Backlink Referrer ${tag}`,
      keys: { email: `backlink-${tag}@example.test` },
      source: { class: 'manual' },
    })
    const [dealEnt] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `BacklinkDeal ${tag}` })
      .returning({ id: entity.id })
    await setValues({
      entityId: dealEnt.id,
      patch: { source: 'referral', referred_by: person.entityId },
      actor: { type: 'user', id: actor.id },
    })

    // The inbound-references query every record page's backlink section
    // runs (`getObjectRecord`'s `referencedBy`, objects.ts): to_entity_id =
    // this record, relation = 'references', alive referrers only.
    const referencedBy = await db
      .select({
        fromId: link.fromEntityId,
        attrSlug: link.attrSlug,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, person.entityId),
          eq(link.relation, 'references'),
          isNull(entity.mergedIntoId),
        ),
      )
    expect(referencedBy).toEqual([
      {
        fromId: dealEnt.id,
        attrSlug: 'referred_by',
        name: `BacklinkDeal ${tag}`,
        kind: 'deal',
      },
    ])

    // And the context assembler, which walks the same edges, cites it on
    // the person without knowing the slug exists.
    const assembled = await Effect.runPromise(
      assembleProgram(
        { entityId: person.entityId },
        { user: { id: actor.id }, asOf: ASOF, budgetChars: 8000 },
      ),
    )
    expect(assembled.items.map((i) => i.ref)).toContain(
      `attr:${dealEnt.id}:referred_by`,
    )
  })
})
