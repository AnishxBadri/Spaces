import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

/**
 * Integration test against the test database. Builds two companies with
 * aliases, a mention link, a space tag, and a candidate — merges — then
 * asserts every repoint, the redirect, and the snapshot.
 */
describe('mergeEntities', () => {
  it('repoints everything, redirects the loser, snapshots the lot', async () => {
    const { resolveEntity, addIdentityAlias } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('@spaces/db')
    const {
      attributeEvent,
      duplicateCandidate,
      entity,
      entityAlias,
      entitySpace,
      link,
      mergeEvent,
      space,
    } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq, or } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    expect(actor).toBeTruthy()

    // Winner and loser with distinct domains.
    const winner = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag}`,
      keys: { domain: `mergeco-${tag}.com` },
      source: { class: 'manual' },
    })
    const loser = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag} Pvt Ltd`,
      keys: { domain: `mergeco-${tag}.in` },
      source: { class: 'manual' },
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
      .update(entity)
      .set({ values: { funding_stage: 'seed' } })
      .where(eq(entity.id, loser.entityId))

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

    // Null value filled from loser.
    const [wEnt] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, winner.entityId))
    expect(wEnt.values.funding_stage).toBe('seed')

    // …and the fill is logged as the system's rewrite through the merge
    // door — never as the merging user's edit.
    const [fillEvent] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, winner.entityId),
          eq(attributeEvent.attrSlug, 'funding_stage'),
        ),
      )
    expect(fillEvent).toBeTruthy()
    expect(fillEvent.actorType).toBe('system')
    expect(fillEvent.actorId).toBeNull()
    expect(fillEvent.source).toBe('merge')
    expect(fillEvent.to).toBe('seed')

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
    const snap = event.snapshot
    expect(snap.some((s) => s.table === 'entity_alias')).toBe(true)
    expect(snap.some((s) => s.table === 'link')).toBe(true)
    expect(snap.some((s) => s.table === 'entity_space')).toBe(true)

    // Resolving the loser's domain now attaches to the winner.
    const reResolved = await resolveEntity({
      kind: 'company',
      keys: { domain: `mergeco-${tag}.in` },
      source: { class: 'import' },
    })
    expect(reResolved.action).toBe('attached')
    expect(reResolved.entityId).toBe(winner.entityId)

    // Adding winner's own domain back reports already_own via redirect.
    const own = await addIdentityAlias(
      loser.entityId,
      'domain',
      `mergeco-${tag}.com`,
      { class: 'manual' },
    )
    expect(own.outcome).toBe('already_own')
  })

  it('generic strategies: repoint-or-drop collides on composite and id PKs, repoint is plain', async () => {
    const { resolveEntity } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('@spaces/db')
    const { entity, entitySpace, mergeEvent, signal, space } =
      await import('@spaces/db/schema')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq, inArray } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    expect(actor).toBeTruthy()

    const winner = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag} W`,
      keys: { domain: `mergeco-w-${tag}.com` },
      source: { class: 'manual' },
    })
    const loser = await resolveEntity({
      kind: 'company',
      name: `MergeCo ${tag} L`,
      keys: { domain: `mergeco-l-${tag}.com` },
      source: { class: 'manual' },
    })

    // Composite-PK collision: both tagged in the same space.
    const [spc] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `TestSpace ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: spc.id,
      slug: `testspace_${tag}`,
      path: `testspace_${tag}`,
    })
    await db.insert(entitySpace).values([
      { entityId: winner.entityId, spaceId: spc.id, source: 'manual' },
      { entityId: loser.entityId, spaceId: spc.id, source: 'manual' },
    ])

    // Id-PK collision (shared task) + plain repoint (loser-only task).
    const [shared] = await db
      .insert(task)
      .values({
        content: `shared ${tag}`,
        assigneeId: actor.id,
        createdBy: actor.id,
      })
      .returning({ id: task.id })
    const [loserOnly] = await db
      .insert(task)
      .values({
        content: `loser ${tag}`,
        assigneeId: actor.id,
        createdBy: actor.id,
      })
      .returning({ id: task.id })
    await db.insert(taskEntity).values([
      { taskId: shared.id, entityId: winner.entityId },
      { taskId: shared.id, entityId: loser.entityId },
      { taskId: loserOnly.id, entityId: loser.entityId },
    ])

    // Plain repoint.
    const [sig] = await db
      .insert(signal)
      .values({ entityId: loser.entityId, source: 'test', payload: { tag } })
      .returning({ id: signal.id })

    try {
      const { mergeEventId } = await mergeEntities({
        winnerId: winner.entityId,
        loserId: loser.entityId,
        mergedBy: actor.id,
      })

      // Space: one row, the winner's.
      const tags = await db
        .select()
        .from(entitySpace)
        .where(eq(entitySpace.spaceId, spc.id))
      expect(tags.map((t) => t.entityId)).toEqual([winner.entityId])

      // Tasks: shared task links the winner once; loser-only task moved.
      const sharedLinks = await db
        .select()
        .from(taskEntity)
        .where(eq(taskEntity.taskId, shared.id))
      expect(sharedLinks.map((t) => t.entityId)).toEqual([winner.entityId])
      const moved = await db
        .select()
        .from(taskEntity)
        .where(
          and(
            eq(taskEntity.taskId, loserOnly.id),
            eq(taskEntity.entityId, winner.entityId),
          ),
        )
      expect(moved.length).toBe(1)

      // Signal followed the record.
      const [s] = await db
        .select({ entityId: signal.entityId })
        .from(signal)
        .where(eq(signal.id, sig.id))
      expect(s.entityId).toBe(winner.entityId)

      // Snapshot says what happened, labelled by table.
      const [event] = await db
        .select({ snapshot: mergeEvent.snapshot })
        .from(mergeEvent)
        .where(eq(mergeEvent.id, mergeEventId))
      const snap = event.snapshot
      const of = (table: string) =>
        snap
          .filter((e) => e.table === table)
          .map((e) => e.action)
          .sort()
      expect(of('entity_space')).toEqual(['dropped'])
      expect(of('task_entity')).toEqual(['dropped', 'repointed'])
      expect(of('signal')).toEqual(['repointed'])
    } finally {
      await db.delete(signal).where(eq(signal.id, sig.id))
      await db
        .delete(taskEntity)
        .where(inArray(taskEntity.taskId, [shared.id, loserOnly.id]))
      await db.delete(task).where(inArray(task.id, [shared.id, loserOnly.id]))
    }
  })

  it('repoints referred_by on every deal that named the loser', async () => {
    const { resolveEntity } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { setValues } = await import('#/lib/attributes/values')
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, link } = await import('@spaces/db/schema')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    expect(actor).toBeTruthy()

    // Two records of the same person; the deal named the one that loses.
    const winner = await resolveEntity({
      kind: 'person',
      name: `Referrer ${tag}`,
      keys: { email: `referrer-w-${tag}@example.test` },
      source: { class: 'manual' },
    })
    const loser = await resolveEntity({
      kind: 'person',
      name: `Referrer ${tag} (dup)`,
      keys: { email: `referrer-l-${tag}@example.test` },
      source: { class: 'manual' },
    })
    const [dealEnt] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: `ReferredDeal ${tag}` })
      .returning({ id: entity.id })
    await setValues({
      entityId: dealEnt.id,
      patch: { source: 'referral', referred_by: loser.entityId },
      actor: { type: 'user', id: actor.id },
    })

    await mergeEntities({
      winnerId: winner.entityId,
      loserId: loser.entityId,
      mergedBy: actor.id,
    })

    // The value lives in values jsonb, so the repoint is the referrers'
    // pass over inbound reference links — not an ENTITY_REFS column.
    const [deal] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, dealEnt.id))
    expect(deal.values.referred_by).toBe(winner.entityId)

    const refLinks = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, dealEnt.id),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'referred_by'),
        ),
      )
    expect(refLinks.map((l) => l.toEntityId)).toEqual([winner.entityId])

    // …and the rewrite is the system's, through the merge door.
    const [repointEvent] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, dealEnt.id),
          eq(attributeEvent.attrSlug, 'referred_by'),
          eq(attributeEvent.source, 'merge'),
        ),
      )
    expect(repointEvent).toBeTruthy()
    expect(repointEvent.actorType).toBe('system')
    expect(repointEvent.from).toBe(loser.entityId)
    expect(repointEvent.to).toBe(winner.entityId)
  })

  it('refuses cross-kind and self merges', async () => {
    const { resolveEntity } = await import('./resolve')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('@spaces/db')
    const { user } = await import('@spaces/db/schema/auth')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const c = await resolveEntity({
      kind: 'company',
      name: `KindCo ${tag}`,
      source: { class: 'manual' },
    })
    const p = await resolveEntity({
      kind: 'person',
      name: `KindPerson ${tag}`,
      keys: { email: `kind-${tag}@example.dev` },
      source: { class: 'manual' },
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
