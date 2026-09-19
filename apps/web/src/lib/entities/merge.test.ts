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

  /**
   * Customs are merge-as-target since the two-tier model was narrowed
   * (CONTEXT.md, 2026-09-13). They have no side table, so the whole job is
   * the ENTITY_REFS loop — these two tests are what says so: one proves the
   * object guard refuses a Fund/Vendor pair without writing a row, the other
   * walks a real pair through every generic strategy.
   */
  it('refuses two custom records of different objects and writes nothing', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram } =
      await import('#/lib/attributes/object-registry')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('@spaces/db')
    const { attributeEvent, entity, link, mergeEvent } =
      await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { user } = await import('@spaces/db/schema/auth')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const me = { type: 'user' as const, id: actor.id }

    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: actor.id,
      }),
    )
    const vendors = await Effect.runPromise(
      createObjectProgram({
        singular: `Vendor ${tag}`,
        plural: `Vendors ${tag}`,
        createdBy: actor.id,
      }),
    )
    const fund = await Effect.runPromise(
      createRecordProgram({
        objectId: funds.id,
        name: `Fund I ${tag}`,
        actor: me,
      }),
    )
    const vendor = await Effect.runPromise(
      createRecordProgram({
        objectId: vendors.id,
        name: `Vendor A ${tag}`,
        actor: me,
      }),
    )

    // Same kind (`custom`), different object: the pair guard has to read
    // object_id or this merge would go through.
    const counts = async () => ({
      entity: (await db.select({ id: entity.id }).from(entity)).length,
      link: (await db.select({ id: link.id }).from(link)).length,
      attributeEvent: (
        await db.select({ id: attributeEvent.id }).from(attributeEvent)
      ).length,
      activity: (await db.select({ id: activity.id }).from(activity)).length,
      mergeEvent: (await db.select({ id: mergeEvent.id }).from(mergeEvent))
        .length,
    })
    const before = await counts()
    await expect(
      mergeEntities({
        winnerId: fund.id,
        loserId: vendor.id,
        mergedBy: actor.id,
      }),
    ).rejects.toThrow('Only records of the same object can merge')
    expect(await counts()).toEqual(before)
  })

  it('merges two records of one custom object through the generic registry loop', async () => {
    const { Effect } = await import('effect')
    const { createObjectProgram, createRecordProgram } =
      await import('#/lib/attributes/object-registry')
    const { createAttributeProgram } = await import('#/lib/attributes/create')
    const { objectIdForKindAsync } = await import('#/lib/attributes/objects')
    const { setValues } = await import('#/lib/attributes/values')
    const { mergeEntities } = await import('./merge')
    const { db } = await import('@spaces/db')
    const {
      attributeEvent,
      duplicateCandidate,
      entity,
      entitySpace,
      link,
      mergeEvent,
      space,
    } = await import('@spaces/db/schema')
    const { activity } = await import('@spaces/db/schema/activity')
    const { task, taskEntity } = await import('@spaces/db/schema/tasks')
    const { user } = await import('@spaces/db/schema/auth')
    const { and, eq, ilike, isNull, or } = await import('drizzle-orm')

    const tag = randomUUID().slice(0, 8)
    const [actor] = await db.select({ id: user.id }).from(user).limit(1)
    const me = { type: 'user' as const, id: actor.id }

    // --- the object and its attributes ------------------------------------
    const funds = await Effect.runPromise(
      createObjectProgram({
        singular: `Fund ${tag}`,
        plural: `Funds ${tag}`,
        createdBy: actor.id,
      }),
    )
    await Effect.runPromise(
      createAttributeProgram({
        objectId: funds.id,
        name: 'Vintage',
        type: 'number',
        default: 2026,
        createdBy: actor.id,
      }),
    )
    const thesis = await Effect.runPromise(
      createAttributeProgram({
        objectId: funds.id,
        name: 'Thesis',
        type: 'text',
        createdBy: actor.id,
      }),
    )
    const region = await Effect.runPromise(
      createAttributeProgram({
        objectId: funds.id,
        name: 'Region',
        type: 'text',
        createdBy: actor.id,
      }),
    )
    const anchor = await Effect.runPromise(
      createAttributeProgram({
        objectId: funds.id,
        name: 'Anchor',
        type: 'record_reference',
        config: { targetKind: 'company' },
        createdBy: actor.id,
      }),
    )
    // …and a company attribute pointing the other way, at a Fund record.
    const companyObjectId = await objectIdForKindAsync('company')
    const backer = await Effect.runPromise(
      createAttributeProgram({
        objectId: companyObjectId,
        name: `Zz backer ${tag}`,
        type: 'record_reference',
        config: { targetObjectId: funds.id },
        createdBy: actor.id,
      }),
    )
    const [anchorCo] = await db
      .insert(entity)
      .values({
        kind: 'company',
        objectId: companyObjectId,
        canonicalName: `AnchorCo ${tag}`,
      })
      .returning({ id: entity.id })
    const [referrer] = await db
      .insert(entity)
      .values({
        kind: 'company',
        objectId: companyObjectId,
        canonicalName: `ReferrerCo ${tag}`,
      })
      .returning({ id: entity.id })

    // --- the pair, and a third record for the candidate re-pair -----------
    const winner = await Effect.runPromise(
      createRecordProgram({
        objectId: funds.id,
        name: `Fund I ${tag}`,
        values: { [thesis.slug]: 'winner thesis' },
        actor: me,
      }),
    )
    const loser = await Effect.runPromise(
      createRecordProgram({
        objectId: funds.id,
        name: `Fund I ${tag} (dup)`,
        values: {
          [thesis.slug]: 'loser thesis',
          [region.slug]: 'EU',
          [anchor.slug]: anchorCo.id,
        },
        actor: me,
      }),
    )
    const third = await Effect.runPromise(
      createRecordProgram({
        objectId: funds.id,
        name: `Fund II ${tag}`,
        actor: me,
      }),
    )

    // Inbound reference: a company names the record that is about to lose.
    await setValues({
      entityId: referrer.id,
      patch: { [backer.slug]: loser.id },
      actor: me,
    })

    // Space tag, inbound mention, a task — one row each on the loser.
    const [spc] = await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: `TestSpace ${tag}` })
      .returning({ id: entity.id })
    await db.insert(space).values({
      entityId: spc.id,
      slug: `testspace_${tag}`,
      path: `testspace_${tag}`,
    })
    await db
      .insert(entitySpace)
      .values({ entityId: loser.id, spaceId: spc.id, source: 'manual' })
    const [noteEnt] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: `TestNote ${tag}` })
      .returning({ id: entity.id })
    await db.insert(link).values({
      fromEntityId: noteEnt.id,
      toEntityId: loser.id,
      relation: 'mentions',
      source: 'extracted',
    })
    const [chore] = await db
      .insert(task)
      .values({
        content: `chase the dup ${tag}`,
        assigneeId: actor.id,
        createdBy: actor.id,
      })
      .returning({ id: task.id })
    await db.insert(taskEntity).values({ taskId: chore.id, entityId: loser.id })

    // The candidate that triggers the merge, plus one open elsewhere.
    // Upserts, not inserts: since SPA-60 a custom record is born with a name
    // alias and joins the fuzzy sweep, so these near-identical fixture names
    // have already proposed themselves and a plain insert would collide with
    // `duplicate_pair_unique`.
    const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x])
    const target = [duplicateCandidate.entityA, duplicateCandidate.entityB]
    const [ta, tb] = pair(winner.id, loser.id)
    const [trigger] = await db
      .insert(duplicateCandidate)
      .values({
        entityA: ta,
        entityB: tb,
        score: 0.9,
        reason: { rule: 'name' },
      })
      .onConflictDoUpdate({ target, set: { reason: { rule: 'name' } } })
      .returning({ id: duplicateCandidate.id })
    const [oa, ob] = pair(third.id, loser.id)
    await db
      .insert(duplicateCandidate)
      .values({
        entityA: oa,
        entityB: ob,
        score: 0.8,
        reason: { rule: 'name' },
      })
      .onConflictDoUpdate({ target, set: { reason: { rule: 'name' } } })

    const eventsBefore = await db
      .select({ id: attributeEvent.id })
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, loser.id))
    const activityBefore = await db
      .select({ id: activity.id })
      .from(activity)
      .where(eq(activity.subjectEntityId, loser.id))
    expect(eventsBefore.length).toBeGreaterThan(0)
    expect(activityBefore.length).toBeGreaterThan(0)

    // --- merge ------------------------------------------------------------
    const { mergeEventId } = await mergeEntities({
      winnerId: winner.id,
      loserId: loser.id,
      mergedBy: actor.id,
      candidateId: trigger.id,
    })

    // Space tag, task and mention followed the record.
    const tags = await db
      .select({ entityId: entitySpace.entityId })
      .from(entitySpace)
      .where(eq(entitySpace.spaceId, spc.id))
    expect(tags.map((t) => t.entityId)).toEqual([winner.id])
    const taskLinks = await db
      .select({ entityId: taskEntity.entityId })
      .from(taskEntity)
      .where(eq(taskEntity.taskId, chore.id))
    expect(taskLinks.map((t) => t.entityId)).toEqual([winner.id])
    const mentions = await db
      .select({ toEntityId: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, noteEnt.id), eq(link.relation, 'mentions')),
      )
    expect(mentions.map((l) => l.toEntityId)).toEqual([winner.id])

    // Links moved in both directions: the record's own outbound reference…
    const outbound = await db
      .select({ toEntityId: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, winner.id), eq(link.attrSlug, anchor.slug)),
      )
    expect(outbound.map((l) => l.toEntityId)).toEqual([anchorCo.id])
    // …and the company that pointed at it, values and link together.
    const [referrerRow] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, referrer.id))
    expect(referrerRow.values[backer.slug]).toBe(winner.id)
    const inbound = await db
      .select({ toEntityId: link.toEntityId })
      .from(link)
      .where(
        and(eq(link.fromEntityId, referrer.id), eq(link.attrSlug, backer.slug)),
      )
    expect(inbound.map((l) => l.toEntityId)).toEqual([winner.id])

    // History and activity are the plain `repoint` strategy.
    const eventsAfter = await db
      .select({ id: attributeEvent.id })
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, loser.id))
    expect(eventsAfter.length).toBe(0)
    const activityAfter = await db
      .select({ id: activity.id })
      .from(activity)
      .where(eq(activity.subjectEntityId, loser.id))
    expect(activityAfter.length).toBe(0)

    // Values: winner keeps, loser fills the blanks, conflicts are recorded.
    const [winnerRow] = await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, winner.id))
    expect(winnerRow.values[thesis.slug]).toBe('winner thesis')
    expect(winnerRow.values[region.slug]).toBe('EU')
    expect(winnerRow.values[anchor.slug]).toBe(anchorCo.id)

    // Each fill is the system's write through the merge door — the same
    // shape the company/person merge has always written.
    const [fill] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, winner.id),
          eq(attributeEvent.attrSlug, region.slug),
          eq(attributeEvent.source, 'merge'),
        ),
      )
    expect(fill).toBeTruthy()
    expect(fill.actorType).toBe('system')
    expect(fill.actorId).toBeNull()
    expect(fill.actorRef).toBeNull()
    expect(fill.from).toBeNull()
    expect(fill.to).toBe('EU')
    // …and so is the referrer's repoint.
    const [repoint] = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, referrer.id),
          eq(attributeEvent.attrSlug, backer.slug),
          eq(attributeEvent.source, 'merge'),
        ),
      )
    expect(repoint.actorType).toBe('system')
    expect(repoint.from).toBe(loser.id)
    expect(repoint.to).toBe(winner.id)

    // Candidates: the trigger closes, the other one re-pairs to the winner.
    const [triggerRow] = await db
      .select({ status: duplicateCandidate.status })
      .from(duplicateCandidate)
      .where(eq(duplicateCandidate.id, trigger.id))
    expect(triggerRow.status).toBe('merged')
    const stillOpen = await db
      .select({ id: duplicateCandidate.id })
      .from(duplicateCandidate)
      .where(
        and(
          or(
            eq(duplicateCandidate.entityA, loser.id),
            eq(duplicateCandidate.entityB, loser.id),
          ),
          eq(duplicateCandidate.status, 'open'),
        ),
      )
    expect(stillOpen.length).toBe(0)
    const [wa, wb] = pair(third.id, winner.id)
    const repaired = await db
      .select({ id: duplicateCandidate.id })
      .from(duplicateCandidate)
      .where(
        and(
          eq(duplicateCandidate.entityA, wa),
          eq(duplicateCandidate.entityB, wb),
        ),
      )
    expect(repaired.length).toBe(1)

    // --- the snapshot: one entry per moved row, no hand-written section ---
    const [event] = await db
      .select({ snapshot: mergeEvent.snapshot })
      .from(mergeEvent)
      .where(eq(mergeEvent.id, mergeEventId))
    const snap = event.snapshot
    const countOf = (table: string, action: string) =>
      snap.filter((e) => e.table === table && e.action === action).length
    expect(countOf('entity_space', 'repointed')).toBe(1)
    expect(countOf('task_entity', 'repointed')).toBe(1)
    expect(countOf('link', 'repointed')).toBe(3) // mention in, ref in, ref out
    expect(countOf('attribute_event', 'repointed')).toBe(eventsBefore.length)
    expect(countOf('activity', 'repointed')).toBe(activityBefore.length)
    expect(
      snap.filter((e) => e.action === 'field_conflict').map((e) => e.old.field),
    ).toEqual([thesis.slug])
    expect(
      snap
        .filter((e) => e.action === 'field_filled')
        .map((e) => e.old.field)
        .sort(),
    ).toEqual([anchor.slug, region.slug].sort())

    // --- the loser is a redirect, and gone from every list -----------------
    // `getObjectRecord` returns this column as `mergedIntoId` and the record
    // route's loader (routes/_app/o_.$objectSlug.$recordId.tsx) turns it into
    // a redirect to the winner — asserted here at the data the loader reads.
    const [loserRow] = await db
      .select({ mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, loser.id))
    expect(loserRow.mergedIntoId).toBe(winner.id)
    // `listObjectRecords`' filter (lib/server/objects.ts) — the `/o/<slug>`
    // list page.
    const listed = await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          eq(entity.objectId, funds.id),
          eq(entity.kind, 'custom'),
          isNull(entity.mergedIntoId),
        ),
      )
    expect(listed.map((r) => r.id).sort()).toEqual([winner.id, third.id].sort())
    // Cmd-K: `searchAll`'s name_hits CTE and `searchEntities` both gate on
    // `merged_into_id is null`, so the loser cannot surface under its name.
    const hits = await db
      .select({ id: entity.id })
      .from(entity)
      .where(
        and(
          ilike(entity.canonicalName, `%Fund I ${tag}%`),
          isNull(entity.mergedIntoId),
        ),
      )
    expect(hits.map((r) => r.id)).toEqual([winner.id])
  })
})
