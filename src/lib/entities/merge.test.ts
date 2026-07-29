import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupTestEntities } from './test-helpers'

afterAll(async () => {
  if (!process.env.DATABASE_URL) return
  await cleanupTestEntities([
    '^(MergeCo|KindCo|KindPerson|TestSpace|TestNote) [0-9a-f]{4,8}( .*)?$',
  ])
})

const hasDb = Boolean(process.env.DATABASE_URL)

/**
 * Integration test against the dev database. Builds two companies with
 * aliases, a mention link, a space tag, and a candidate — merges — then
 * asserts every repoint, the redirect, and the snapshot.
 */
describe.skipIf(!hasDb)('mergeEntities', () => {
  it('repoints everything, redirects the loser, snapshots the lot', async () => {
    const { resolveEntity, addIdentityAlias } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('#/db')
    const {
      company,
      duplicateCandidate,
      entity,
      entityAlias,
      entitySpace,
      link,
      mergeEvent,
      space,
    } = await import('#/db/schema')
    const { user } = await import('#/db/schema/auth')
    const { and, eq, or } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    expect(actor).toBeTruthy()

    // Winner and loser with distinct domains.
    const winner = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag}`,
      keys: { domain: `mergeco-${tag}.com` },
      source: 'manual',
    })
    const loser = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag} Pvt Ltd`,
      keys: { domain: `mergeco-${tag}.in` },
      source: 'manual',
    })
    // Fuzzy sweep should already have suggested this pair.
    const [a, b] =
      winner.entityId < loser.entityId
        ? [winner.entityId, loser.entityId]
        : [loser.entityId, winner.entityId]
    const [candidate] = await db
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          eq(duplicateCandidate.entityA, a),
          eq(duplicateCandidate.entityB, b),
        ),
      )
    expect(candidate).toBeTruthy()

    // Loser gets: a space tag, an inbound mention link, stage attr.
    const [spc] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `TestSpace ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: spc.id,
      slug: `testspace_${tag}`,
      path: `testspace_${tag}`,
    })
    await db.insert(entitySpace).values({
      entityId: loser.entityId,
      spaceId: spc.id,
      source: 'manual',
    })
    const [noteEnt] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `TestNote ${tag}` })
      .returning({ id: entity.id })
    await db.insert(link).values({
      fromEntityId: noteEnt.id,
      toEntityId: loser.entityId,
      relation: 'mentions',
      source: 'extracted',
    })
    await db
      .update(company)
      .set({ stage: 'Seed' })
      .where(eq(company.entityId, loser.entityId))

    // Merge.
    const { mergeEventId } = await mergeEntities({
      winnerId: winner.entityId,
      loserId: loser.entityId,
      mergedBy: actor.id,
      candidateId: candidate.id,
    })

    // Loser redirects.
    const [loserRow] = await db
      .select({ mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, loser.entityId))
    expect(loserRow.mergedIntoId).toBe(winner.entityId)

    // Domain alias moved: winner now owns both domains.
    const winnerDomains = await db
      .select({ valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(
        and(
          eq(entityAlias.entityId, winner.entityId),
          eq(entityAlias.kind, 'domain'),
        ),
      )
    expect(winnerDomains.map((d) => d.valueNorm).sort()).toEqual(
      [`mergeco-${tag}.com`, `mergeco-${tag}.in`].sort(),
    )

    // Mention link repointed.
    const [movedLink] = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, noteEnt.id),
          eq(link.toEntityId, winner.entityId),
        ),
      )
    expect(movedLink).toBeTruthy()

    // Space tag repointed.
    const [movedTag] = await db
      .select()
      .from(entitySpace)
      .where(
        and(
          eq(entitySpace.entityId, winner.entityId),
          eq(entitySpace.spaceId, spc.id),
        ),
      )
    expect(movedTag).toBeTruthy()

    // Null field filled from loser.
    const [wCompany] = await db
      .select({ stage: company.stage })
      .from(company)
      .where(eq(company.entityId, winner.entityId))
    expect(wCompany.stage).toBe('Seed')

    // Candidate closed; no open candidates left on the pair.
    const openLeft = await db
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          or(
            eq(duplicateCandidate.entityA, loser.entityId),
            eq(duplicateCandidate.entityB, loser.entityId),
          ),
          eq(duplicateCandidate.status, 'open'),
        ),
      )
    expect(openLeft.length).toBe(0)

    // Snapshot recorded the moves.
    const [event] = await db
      .select()
      .from(mergeEvent)
      .where(eq(mergeEvent.id, mergeEventId))
    const snap = event.snapshot as Array<{ table: string }>
    expect(snap.some((s) => s.table === 'entity_alias')).toBe(true)
    expect(snap.some((s) => s.table === 'link')).toBe(true)
    expect(snap.some((s) => s.table === 'entity_space')).toBe(true)

    // Resolving the loser's domain now attaches to the winner.
    const reResolved = await resolveEntity({
      kind: 'company',
      keys: { domain: `mergeco-${tag}.in` },
      source: 'import',
    })
    expect(reResolved.action).toBe('attached')
    expect(reResolved.entityId).toBe(winner.entityId)

    // Adding winner's own domain back reports already_own via redirect.
    const own = await addIdentityAlias(
      loser.entityId,
      'domain',
      `mergeco-${tag}.com`,
      'manual',
    )
    expect(own.outcome).toBe('already_own')
  })

  it('refuses cross-kind and self merges', async () => {
    const { resolveEntity } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('#/db')
    const { user } = await import('#/db/schema/auth')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const c = await resolveEntity({
      kind: 'company',
      name: `KindCo ${tag}`,
      source: 'manual',
    })
    const p = await resolveEntity({
      kind: 'person',
      name: `KindPerson ${tag}`,
      keys: { email: `kind-${tag}@example.dev` },
      source: 'manual',
    })
    await expect(
      mergeEntities({
        winnerId: c.entityId,
        loserId: p.entityId,
        mergedBy: actor.id,
      }),
    ).rejects.toThrow(/same-kind/)
    await expect(
      mergeEntities({
        winnerId: c.entityId,
        loserId: c.entityId,
        mergedBy: actor.id,
      }),
    ).rejects.toThrow(/itself/)
  })
})
