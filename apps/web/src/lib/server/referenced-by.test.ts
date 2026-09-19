import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The person page's "Referred deals" section (SPA-153). SPA-59 already
 * writes the edge — `deal.referred_by` syncs a
 * `link(relation:'references', attr_slug:'referred_by')` row — and
 * `apps/web/src/lib/attributes/referred-by.test.ts` pins that write. What
 * these tests pin is the read: the inbound-references query lifted out of
 * `getObjectRecord` into `referencedByRows`, and the grouping by
 * `attr_slug` that gives every record-reference attribute pointing at a
 * person its own heading without a page edit.
 *
 * The render half is unproven here on purpose — the route renders exactly
 * these groups (`people_.$personId.tsx`), one `RecordSection` per group,
 * each row linked through `recordPath`.
 */

const actorId = async () => {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

/** A person, and `n` deals whose `referred_by` is that person. */
async function referredDeals(tag: string, names: Array<string>) {
  const { resolveEntity } = await import('../entities/resolve')
  const { setValues } = await import('../attributes/values')
  const { objectIdForKindAsync } = await import('../attributes/objects')
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')

  const actor = await actorId()
  const person = await resolveEntity({
    kind: 'person',
    name: `Referrer ${tag}`,
    keys: { email: `referrer-${tag}@example.test` },
    source: { class: 'manual' },
  })
  const objectId = await objectIdForKindAsync('deal')
  const deals: Array<{ id: string; name: string }> = []
  for (const name of names) {
    const [row] = await db
      .insert(entity)
      .values({ kind: 'deal', objectId, canonicalName: name })
      .returning({ id: entity.id })
    await setValues({
      entityId: row.id,
      patch: { referred_by: person.entityId },
      actor: { type: 'user', id: actor },
    })
    deals.push({ id: row.id, name })
  }
  return { personId: person.entityId, deals }
}

describe('the person page — referred deals', () => {
  it('groups both deals under one data-derived heading, each linkable', async () => {
    const { groupReferencedBy, referencedByRows } = await import('./shared')
    const { recordPath } = await import('#/lib/record-path')

    const tag = randomUUID().slice(0, 8)
    const { personId, deals } = await referredDeals(tag, [
      `Alpha ${tag}`,
      `Beta ${tag}`,
    ])

    const groups = groupReferencedBy(await referencedByRows(personId))
    expect(groups.length).toBe(1)
    const [group] = groups
    // The heading is the attribute's display name ("Referred by") over the
    // referring object's plural ("Deals") — not a literal in the page.
    expect(group.label).toBe('Referred deals')
    expect(group.attrSlug).toBe('referred_by')
    expect(group.items.map((i) => i.name).sort()).toEqual(
      deals.map((d) => d.name).sort(),
    )
    // Every row has a destination, and it is the deal's own page.
    for (const item of group.items) {
      expect(item.kind).toBe('deal')
      expect(item.objectSingular).toBe('Deal')
      expect(
        recordPath({
          kind: item.kind,
          id: item.id,
          objectSlug: item.objectSlug,
        }),
      ).toBe(`/deals/${item.id}`)
    }
  })

  it('gives a person referred on nothing no group, so the page shows no heading', async () => {
    const { resolveEntity } = await import('../entities/resolve')
    const { groupReferencedBy, referencedByRows } = await import('./shared')

    const tag = randomUUID().slice(0, 8)
    const lonely = await resolveEntity({
      kind: 'person',
      name: `Unreferred ${tag}`,
      keys: { email: `unreferred-${tag}@example.test` },
      source: { class: 'manual' },
    })
    expect(groupReferencedBy(await referencedByRows(lonely.entityId))).toEqual(
      [],
    )
  })

  it('drops a deal from the section when its referred_by is cleared', async () => {
    const { setValues } = await import('../attributes/values')
    const { groupReferencedBy, referencedByRows } = await import('./shared')

    const tag = randomUUID().slice(0, 8)
    const { personId, deals } = await referredDeals(tag, [
      `Kept ${tag}`,
      `Cleared ${tag}`,
    ])
    await setValues({
      entityId: deals[1].id,
      patch: { referred_by: null },
      actor: { type: 'user', id: await actorId() },
    })

    const groups = groupReferencedBy(await referencedByRows(personId))
    expect(groups.length).toBe(1)
    expect(groups[0].items.map((i) => i.name)).toEqual([`Kept ${tag}`])
  })

  it('gives a second record-reference attribute its own heading, no page edit', async () => {
    const { setValues } = await import('../attributes/values')
    const { objectIdForKindAsync } = await import('../attributes/objects')
    const { groupReferencedBy, referencedByRows } = await import('./shared')
    const { db } = await import('@spaces/db')
    const { attribute } = await import('@spaces/db/schema')

    const tag = randomUUID().slice(0, 8)
    const { personId, deals } = await referredDeals(tag, [`Gamma ${tag}`])

    // A second attribute on deals pointing at people. Nothing about the
    // section knows it exists — the grouping is attr_slug.
    const slug = `champion_${tag}`
    await db.insert(attribute).values({
      objectId: await objectIdForKindAsync('deal'),
      slug,
      name: 'Champion',
      type: 'record_reference',
      options: { targetKind: 'person', multi: false },
    })
    await setValues({
      entityId: deals[0].id,
      patch: { [slug]: personId },
      actor: { type: 'user', id: await actorId() },
    })

    const groups = groupReferencedBy(await referencedByRows(personId))
    expect(groups.map((g) => g.label)).toEqual([
      'Champion deals',
      'Referred deals',
    ])
    expect(groups.map((g) => g.attrSlug).sort()).toEqual(
      [slug, 'referred_by'].sort(),
    )
    for (const group of groups) {
      expect(group.items.map((i) => i.name)).toEqual([`Gamma ${tag}`])
    }
  })
})

describe('the custom-record page — referenced by, unchanged', () => {
  it('still gets the flat rows it rendered before the query moved', async () => {
    const { setValues } = await import('../attributes/values')
    const { referencedByRows } = await import('./shared')
    const { recordPath } = await import('#/lib/record-path')
    const { db } = await import('@spaces/db')
    const { attribute, entity, objectDef } = await import('@spaces/db/schema')

    const tag = randomUUID().slice(0, 8)
    const [obj] = await db
      .insert(objectDef)
      .values({
        slug: `vehicles_${tag}`,
        singular: 'Vehicle',
        plural: 'Vehicles',
      })
      .returning({ id: objectDef.id })
    await db.insert(attribute).values({
      objectId: obj.id,
      slug: 'sponsor',
      name: 'Sponsor',
      type: 'record_reference',
      options: { targetObjectId: obj.id, multi: false },
    })
    const [target] = await db
      .insert(entity)
      .values({
        kind: 'custom',
        objectId: obj.id,
        canonicalName: `Target ${tag}`,
      })
      .returning({ id: entity.id })
    const [referrer] = await db
      .insert(entity)
      .values({
        kind: 'custom',
        objectId: obj.id,
        canonicalName: `Referrer ${tag}`,
      })
      .returning({ id: entity.id })
    await setValues({
      entityId: referrer.id,
      patch: { sponsor: target.id },
      actor: { type: 'user', id: await actorId() },
    })

    const rows = await referencedByRows(target.id)
    expect(rows.length).toBe(1)
    const [row] = rows
    // The six fields the custom record page reads, exactly as before.
    expect(row.fromId).toBe(referrer.id)
    expect(row.attrSlug).toBe('sponsor')
    expect(row.name).toBe(`Referrer ${tag}`)
    expect(row.kind).toBe('custom')
    expect(row.objectSlug).toBe(`vehicles_${tag}`)
    expect(row.objectSingular).toBe('Vehicle')
    expect(
      recordPath({
        kind: row.kind,
        id: row.fromId,
        objectSlug: row.objectSlug,
      }),
    ).toBe(`/o/vehicles_${tag}/${referrer.id}`)
  })

  it('excludes a merged-away referrer, as the gated query did', async () => {
    const { referencedByRows } = await import('./shared')
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const { personId, deals } = await referredDeals(tag, [`Doomed ${tag}`])
    expect((await referencedByRows(personId)).length).toBe(1)

    const [survivor] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `Survivor ${tag}` })
      .returning({ id: entity.id })
    await db
      .update(entity)
      .set({ mergedIntoId: survivor.id })
      .where(eq(entity.id, deals[0].id))

    expect(await referencedByRows(personId)).toEqual([])
  })
})
