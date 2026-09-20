import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * The space page's Contacts lanes (SPA-99), against the test database.
 *
 * What is worth pinning is the reconciliation the slice exists for: the
 * direct lane reads `entity_space`, which accepts any kind, so it has to be
 * the `person` join that makes it a contacts lane — and a person who is
 * both tagged here *and* a contact at a company here belongs to the direct
 * lane alone, or the page tells two stories about one person.
 *
 * Dynamic imports for the reason the rest of the DB-coupled suite uses
 * them: `@spaces/db` builds its pool from `DATABASE_URL` at import time and
 * `vitest.setup.ts` rewrites it per file. The programs are called directly —
 * `getSpace` needs a request no test has, which is why the queries live
 * outside `lib/server/` at all.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function aSpace(tag: string): Promise<string> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return createSpaceRow(`Hydrogen ${tag}`, null, await actorId())
}

/** A live person, optionally with a job title and tagged into a space. */
async function aPerson(
  name: string,
  opts?: { jobTitle?: string; spaceId?: string },
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, entitySpace, person } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({
      kind: 'person',
      canonicalName: name,
      ...(opts?.jobTitle ? { values: { job_title: opts.jobTitle } } : {}),
    })
    .returning({ id: entity.id })
  await db.insert(person).values({ entityId: ent.id })
  if (opts?.spaceId) {
    await db
      .insert(entitySpace)
      .values({
        entityId: ent.id,
        spaceId: opts.spaceId,
        createdBy: await actorId(),
      })
      .onConflictDoNothing()
  }
  return ent.id
}

/** A live company, optionally tagged into a space. */
async function aCompany(name: string, spaceId?: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity, entitySpace } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  if (spaceId) {
    await db
      .insert(entitySpace)
      .values({ entityId: ent.id, spaceId, createdBy: await actorId() })
  }
  return ent.id
}

/** `link(contact_at)` — the edge the company page's Contacts rail reads. */
async function contactAt(personId: string, companyId: string): Promise<void> {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  await db
    .insert(link)
    .values({
      fromEntityId: personId,
      toEntityId: companyId,
      relation: 'contact_at',
      source: 'manual',
      createdBy: await actorId(),
    })
    .onConflictDoNothing()
}

async function tagInto(entityId: string, spaceId: string): Promise<void> {
  const { db } = await import('@spaces/db')
  const { entitySpace } = await import('@spaces/db/schema')
  await db
    .insert(entitySpace)
    .values({ entityId, spaceId, createdBy: await actorId() })
    .onConflictDoNothing()
}

async function mergeAway(loser: string, winner: string): Promise<void> {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  await db
    .update(entity)
    .set({ mergedIntoId: winner })
    .where(eq(entity.id, loser))
}

async function contactsOf(spaceId: string) {
  const { Effect } = await import('effect')
  const { spaceContactsProgram } = await import('./space-contacts')
  return Effect.runPromise(spaceContactsProgram(spaceId))
}

async function inheritedOf(spaceId: string) {
  const { Effect } = await import('effect')
  const { spaceInheritedContactsProgram } = await import('./space-contacts')
  return Effect.runPromise(spaceInheritedContactsProgram(spaceId))
}

describe('spaceContactsProgram', () => {
  it('reads back the people tagged into the space, alphabetically', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)

    expect(await contactsOf(spaceId)).toEqual([])

    const zoe = await aPerson(`Zoe ${tag}`, { spaceId })
    const abe = await aPerson(`Abe ${tag}`, {
      jobTitle: 'Founder',
      spaceId,
    })

    const rows = await contactsOf(spaceId)
    expect(rows.map((r) => r.id)).toEqual([abe, zoe])
    expect(rows[0].name).toBe(`Abe ${tag}`)
    expect(rows[0].headline).toBe('Founder')
    // Nobody is contact at anything yet, so the secondary fact is honestly
    // absent rather than an empty string.
    expect(rows[0].companies).toBeNull()
    expect(rows[1].headline).toBeNull()
  })

  it('names the contact_at companies on a direct row, joined and ordered', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const personId = await aPerson(`Sarah ${tag}`, { spaceId })

    // Neither company is tagged into the space — the direct row names them
    // because they are the person's companies, not because they are here.
    const ohmium = await aCompany(`Ohmium ${tag}`)
    const electric = await aCompany(`Electric ${tag}`)
    await contactAt(personId, ohmium)
    await contactAt(personId, electric)

    const rows = await contactsOf(spaceId)
    // One row, still — the aggregate is what keeps the lane one row per
    // person rather than one per edge.
    expect(rows).toHaveLength(1)
    expect(rows[0].companies).toBe(`Electric ${tag}, Ohmium ${tag}`)
  })

  it('ignores a tagged company, note or merged-away person', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)

    // `entity_space` accepts any kind — the person join is the whole lane.
    await aCompany(`Ohmium ${tag}`, spaceId)

    const kept = await aPerson(`Kept ${tag}`, { spaceId })
    const gone = await aPerson(`Gone ${tag}`, { spaceId })
    await mergeAway(gone, kept)

    expect((await contactsOf(spaceId)).map((r) => r.id)).toEqual([kept])
  })

  it('does not reach a person tagged into another space', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const elsewhere = await aSpace(`${tag}-b`)

    await aPerson(`Elsewhere ${tag}`, { spaceId: elsewhere })

    expect(await contactsOf(spaceId)).toEqual([])
  })
})

/**
 * The inherited lane. Its three jobs: reach the people the companies here
 * bring with them, leave a doubly-placed person to the direct lane, and keep
 * `merged_into_id` honest on both ends of a join that now carries two
 * `entity` rows.
 */
describe('spaceInheritedContactsProgram', () => {
  it('reads people contact_at a company tagged into the space', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const companyId = await aCompany(`Ohmium ${tag}`, spaceId)

    expect(await inheritedOf(spaceId)).toEqual([])

    const zoe = await aPerson(`Zoe ${tag}`)
    const abe = await aPerson(`Abe ${tag}`, { jobTitle: 'CTO' })
    await contactAt(zoe, companyId)
    await contactAt(abe, companyId)

    const rows = await inheritedOf(spaceId)
    expect(rows.map((r) => r.id)).toEqual([abe, zoe])
    expect(rows[0].companyId).toBe(companyId)
    expect(rows[0].companyName).toBe(`Ohmium ${tag}`)
    expect(rows[0].headline).toBe('CTO')
    expect(rows[0].companies).toBe(`Ohmium ${tag}`)

    // And the direct lane is untouched: nobody was tagged into the space,
    // so the headline count and the header readout are still zero.
    expect(await contactsOf(spaceId)).toEqual([])
  })

  it('leaves a person who is also tagged here to the direct lane', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const companyId = await aCompany(`Ohmium ${tag}`, spaceId)

    const both = await aPerson(`Both ${tag}`, { spaceId })
    const onlyCompany = await aPerson(`Company ${tag}`)
    await contactAt(both, companyId)
    await contactAt(onlyCompany, companyId)

    expect((await contactsOf(spaceId)).map((r) => r.id)).toEqual([both])
    expect((await inheritedOf(spaceId)).map((r) => r.id)).toEqual([onlyCompany])
  })

  it('gives one row per company when a person is contact at two here', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const alpha = await aCompany(`Alpha ${tag}`, spaceId)
    const beta = await aCompany(`Beta ${tag}`, spaceId)

    const personId = await aPerson(`Sarah ${tag}`)
    await contactAt(personId, alpha)
    await contactAt(personId, beta)

    // Two edges, two rows — the company column is what tells them apart,
    // and `link_edge_unique` is what stops a third.
    const rows = await inheritedOf(spaceId)
    expect(rows.map((r) => r.companyName)).toEqual([
      `Alpha ${tag}`,
      `Beta ${tag}`,
    ])
    expect(rows.every((r) => r.id === personId)).toBe(true)
  })

  it('drops a merged-away company and a merged-away person', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)

    const kept = await aCompany(`Kept ${tag}`, spaceId)
    const mergedCompany = await aCompany(`Merged ${tag}`, spaceId)
    await mergeAway(mergedCompany, kept)

    const live = await aPerson(`Live ${tag}`)
    const dead = await aPerson(`Dead ${tag}`)
    const hidden = await aPerson(`Hidden ${tag}`)
    await contactAt(live, kept)
    await contactAt(dead, kept)
    await contactAt(hidden, mergedCompany)
    await mergeAway(dead, live)

    expect((await inheritedOf(spaceId)).map((r) => r.id)).toEqual([live])
  })

  it('is empty for a space with no companies, and for companies with no contacts', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    expect(await inheritedOf(spaceId)).toEqual([])

    await aCompany(`Empty ${tag}`, spaceId)
    expect(await inheritedOf(spaceId)).toEqual([])
  })

  it('does not reach a company that is not tagged into this space', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const elsewhere = await aCompany(`Elsewhere ${tag}`)

    await contactAt(await aPerson(`Nobody ${tag}`), elsewhere)

    expect(await inheritedOf(spaceId)).toEqual([])
  })

  it('reaches a person tagged into another space, which is not this one', async () => {
    const tag = randomUUID().slice(0, 8)
    const spaceId = await aSpace(tag)
    const otherSpace = await aSpace(`${tag}-b`)
    const companyId = await aCompany(`Ohmium ${tag}`, spaceId)

    // The `not exists` is scoped to *this* space: a tag somewhere else is
    // not a reason to drop the row from this space's inherited lane.
    const personId = await aPerson(`Sarah ${tag}`)
    await contactAt(personId, companyId)
    await tagInto(personId, otherSpace)

    expect((await inheritedOf(spaceId)).map((r) => r.id)).toEqual([personId])
  })
})
