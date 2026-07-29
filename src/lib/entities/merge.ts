import { and, eq, or } from 'drizzle-orm'
import { db } from '#/db'
import {
  company,
  duplicateCandidate,
  entity,
  entityAlias,
  entitySpace,
  enrichmentRecord,
  interactionEntity,
  link,
  listEntry,
  listEntryEvent,
  mergeEvent,
  person,
  signal,
} from '#/db/schema'
import { activity } from '#/db/schema/activity'

/**
 * Merge executor, per CONTEXT.md: repoint at write time, resolve nothing at
 * read time. Loser survives as a redirect (merged_into_id); every moved or
 * dropped row lands in merge_event.snapshot so unmerge stays possible.
 *
 * Restricted to company|person|organization and same-kind pairs — spaces,
 * notes, and theses have structural children and different semantics.
 */

type SnapshotEntry = {
  table: string
  action: 'repointed' | 'dropped' | 'field_filled' | 'field_conflict'
  pk: Record<string, unknown>
  old: Record<string, unknown>
}

const MERGEABLE = new Set(['company', 'person', 'organization'])

export async function mergeEntities(opts: {
  winnerId: string
  loserId: string
  mergedBy: string
  candidateId?: string
}): Promise<{ mergeEventId: string }> {
  const { winnerId, loserId, mergedBy } = opts
  if (winnerId === loserId) throw new Error('Cannot merge an entity into itself')

  return db.transaction(async (tx) => {
    const [winner] = await tx
      .select({ id: entity.id, kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, winnerId))
    const [loser] = await tx
      .select({ id: entity.id, kind: entity.kind, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, loserId))
    if (!winner || !loser) throw new Error('Entity not found')
    if (winner.mergedIntoId || loser.mergedIntoId)
      throw new Error('One side is already merged')
    if (winner.kind !== loser.kind)
      throw new Error('Only same-kind entities can merge')
    if (!MERGEABLE.has(winner.kind))
      throw new Error(`Merging ${winner.kind} entities is not supported`)

    const snapshot: Array<SnapshotEntry> = []

    // --- aliases: move to winner; drop exact duplicates -------------------
    const winnerAliases = await tx
      .select({ kind: entityAlias.kind, valueNorm: entityAlias.valueNorm })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, winnerId))
    const winnerAliasKeys = new Set(
      winnerAliases.map((a) => `${a.kind}:${a.valueNorm}`),
    )
    const loserAliases = await tx
      .select()
      .from(entityAlias)
      .where(eq(entityAlias.entityId, loserId))
    for (const a of loserAliases) {
      if (winnerAliasKeys.has(`${a.kind}:${a.valueNorm}`)) {
        snapshot.push({
          table: 'entity_alias',
          action: 'dropped',
          pk: { id: a.id },
          old: a as unknown as Record<string, unknown>,
        })
        await tx.delete(entityAlias).where(eq(entityAlias.id, a.id))
      } else {
        snapshot.push({
          table: 'entity_alias',
          action: 'repointed',
          pk: { id: a.id },
          old: { entityId: loserId },
        })
        await tx
          .update(entityAlias)
          .set({ entityId: winnerId, source: 'merge' })
          .where(eq(entityAlias.id, a.id))
      }
    }

    // --- links: repoint both directions; unique(from,to,relation) --------
    const loserLinks = await tx
      .select()
      .from(link)
      .where(
        or(eq(link.fromEntityId, loserId), eq(link.toEntityId, loserId)),
      )
    for (const l of loserLinks) {
      const newFrom = l.fromEntityId === loserId ? winnerId : l.fromEntityId
      const newTo = l.toEntityId === loserId ? winnerId : l.toEntityId
      snapshot.push({
        table: 'link',
        action: 'repointed',
        pk: { id: l.id },
        old: { fromEntityId: l.fromEntityId, toEntityId: l.toEntityId },
      })
      await tx.delete(link).where(eq(link.id, l.id))
      if (newFrom !== newTo) {
        await tx
          .insert(link)
          .values({ ...l, fromEntityId: newFrom, toEntityId: newTo })
          .onConflictDoNothing()
      }
    }

    // --- space tags: composite PK (entity_id, space_id) -------------------
    const loserTags = await tx
      .select()
      .from(entitySpace)
      .where(eq(entitySpace.entityId, loserId))
    for (const t of loserTags) {
      snapshot.push({
        table: 'entity_space',
        action: 'repointed',
        pk: { entityId: loserId, spaceId: t.spaceId },
        old: t as unknown as Record<string, unknown>,
      })
      await tx
        .delete(entitySpace)
        .where(
          and(
            eq(entitySpace.entityId, loserId),
            eq(entitySpace.spaceId, t.spaceId),
          ),
        )
      await tx
        .insert(entitySpace)
        .values({ ...t, entityId: winnerId })
        .onConflictDoNothing()
    }

    // --- interactions: composite PK --------------------------------------
    const loserInteractions = await tx
      .select()
      .from(interactionEntity)
      .where(eq(interactionEntity.entityId, loserId))
    for (const ie of loserInteractions) {
      snapshot.push({
        table: 'interaction_entity',
        action: 'repointed',
        pk: { interactionId: ie.interactionId, entityId: loserId },
        old: ie as unknown as Record<string, unknown>,
      })
      await tx
        .delete(interactionEntity)
        .where(
          and(
            eq(interactionEntity.interactionId, ie.interactionId),
            eq(interactionEntity.entityId, loserId),
          ),
        )
      await tx
        .insert(interactionEntity)
        .values({ ...ie, entityId: winnerId })
        .onConflictDoNothing()
    }

    // --- signals + enrichment: plain FK repoints --------------------------
    for (const s of await tx
      .select({ id: signal.id })
      .from(signal)
      .where(eq(signal.entityId, loserId))) {
      snapshot.push({
        table: 'signal',
        action: 'repointed',
        pk: { id: s.id },
        old: { entityId: loserId },
      })
    }
    await tx
      .update(signal)
      .set({ entityId: winnerId })
      .where(eq(signal.entityId, loserId))

    for (const r of await tx
      .select({ id: enrichmentRecord.id })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.entityId, loserId))) {
      snapshot.push({
        table: 'enrichment_record',
        action: 'repointed',
        pk: { id: r.id },
        old: { entityId: loserId },
      })
    }
    await tx
      .update(enrichmentRecord)
      .set({ entityId: winnerId })
      .where(eq(enrichmentRecord.entityId, loserId))

    // --- activity: subject + object repoints ------------------------------
    for (const a of await tx
      .select({ id: activity.id })
      .from(activity)
      .where(eq(activity.subjectEntityId, loserId))) {
      snapshot.push({
        table: 'activity.subject',
        action: 'repointed',
        pk: { id: a.id },
        old: { subjectEntityId: loserId },
      })
    }
    await tx
      .update(activity)
      .set({ subjectEntityId: winnerId })
      .where(eq(activity.subjectEntityId, loserId))
    for (const a of await tx
      .select({ id: activity.id })
      .from(activity)
      .where(eq(activity.objectEntityId, loserId))) {
      snapshot.push({
        table: 'activity.object',
        action: 'repointed',
        pk: { id: a.id },
        old: { objectEntityId: loserId },
      })
    }
    await tx
      .update(activity)
      .set({ objectEntityId: winnerId })
      .where(eq(activity.objectEntityId, loserId))

    // --- list entries: one entry per (list, entity) -----------------------
    const loserEntries = await tx
      .select()
      .from(listEntry)
      .where(eq(listEntry.entityId, loserId))
    for (const le of loserEntries) {
      const [collision] = await tx
        .select({ id: listEntry.id })
        .from(listEntry)
        .where(
          and(
            eq(listEntry.listId, le.listId),
            eq(listEntry.entityId, winnerId),
          ),
        )
      if (collision) {
        // Winner already sits in this list — keep winner's entry, snapshot
        // loser's values and its event history, then drop them.
        const events = await tx
          .select()
          .from(listEntryEvent)
          .where(eq(listEntryEvent.entryId, le.id))
        snapshot.push({
          table: 'list_entry',
          action: 'dropped',
          pk: { id: le.id },
          old: {
            entry: le as unknown as Record<string, unknown>,
            events: events as unknown as Array<Record<string, unknown>>,
          },
        })
        await tx.delete(listEntryEvent).where(eq(listEntryEvent.entryId, le.id))
        await tx.delete(listEntry).where(eq(listEntry.id, le.id))
      } else {
        snapshot.push({
          table: 'list_entry',
          action: 'repointed',
          pk: { id: le.id },
          old: { entityId: loserId },
        })
        await tx
          .update(listEntry)
          .set({ entityId: winnerId })
          .where(eq(listEntry.id, le.id))
      }
    }

    // --- side-table fields: winner keeps, loser fills nulls ---------------
    if (winner.kind === 'company') {
      const [w] = await tx
        .select()
        .from(company)
        .where(eq(company.entityId, winnerId))
      const [l] = await tx
        .select()
        .from(company)
        .where(eq(company.entityId, loserId))
      if (w && l) {
        const fill: Partial<typeof w> = {}
        for (const key of ['foundedYear', 'sectors', 'stage', 'geo'] as const) {
          const wv = w[key]
          const lv = l[key]
          if (lv == null) continue
          if (wv == null || (Array.isArray(wv) && wv.length === 0)) {
            ;(fill as Record<string, unknown>)[key] = lv
            snapshot.push({
              table: 'company',
              action: 'field_filled',
              pk: { entityId: winnerId },
              old: { field: key, winnerHad: wv, filledWith: lv },
            })
          } else if (JSON.stringify(wv) !== JSON.stringify(lv)) {
            snapshot.push({
              table: 'company',
              action: 'field_conflict',
              pk: { entityId: winnerId },
              old: { field: key, winnerKept: wv, loserHad: lv },
            })
          }
        }
        if (Object.keys(fill).length > 0) {
          await tx.update(company).set(fill).where(eq(company.entityId, winnerId))
        }
      }
    } else if (winner.kind === 'person') {
      const [w] = await tx
        .select()
        .from(person)
        .where(eq(person.entityId, winnerId))
      const [l] = await tx
        .select()
        .from(person)
        .where(eq(person.entityId, loserId))
      if (w && l) {
        const fill: Partial<typeof w> = {}
        for (const key of ['headline', 'geo'] as const) {
          if (l[key] != null && w[key] == null) {
            ;(fill as Record<string, unknown>)[key] = l[key]
            snapshot.push({
              table: 'person',
              action: 'field_filled',
              pk: { entityId: winnerId },
              old: { field: key, winnerHad: null, filledWith: l[key] },
            })
          }
        }
        if (Object.keys(fill).length > 0) {
          await tx.update(person).set(fill).where(eq(person.entityId, winnerId))
        }
      }
    }

    // --- other open candidates touching the loser repoint to winner -------
    const loserCandidates = await tx
      .select()
      .from(duplicateCandidate)
      .where(
        and(
          or(
            eq(duplicateCandidate.entityA, loserId),
            eq(duplicateCandidate.entityB, loserId),
          ),
          eq(duplicateCandidate.status, 'open'),
        ),
      )
    for (const c of loserCandidates) {
      if (opts.candidateId && c.id === opts.candidateId) continue
      const otherId = c.entityA === loserId ? c.entityB : c.entityA
      snapshot.push({
        table: 'duplicate_candidate',
        action: 'dropped',
        pk: { id: c.id },
        old: c as unknown as Record<string, unknown>,
      })
      await tx.delete(duplicateCandidate).where(eq(duplicateCandidate.id, c.id))
      if (otherId !== winnerId) {
        const [a, b] =
          otherId < winnerId ? [otherId, winnerId] : [winnerId, otherId]
        await tx
          .insert(duplicateCandidate)
          .values({
            entityA: a,
            entityB: b,
            score: c.score,
            reason: c.reason,
          })
          .onConflictDoNothing()
      }
    }

    // --- the candidate that triggered this merge --------------------------
    if (opts.candidateId) {
      await tx
        .update(duplicateCandidate)
        .set({ status: 'merged', resolvedBy: mergedBy, resolvedAt: new Date() })
        .where(eq(duplicateCandidate.id, opts.candidateId))
    }

    // --- redirect + chain flatten ----------------------------------------
    await tx
      .update(entity)
      .set({ mergedIntoId: winnerId })
      .where(eq(entity.id, loserId))
    await tx
      .update(entity)
      .set({ mergedIntoId: winnerId })
      .where(eq(entity.mergedIntoId, loserId))

    const [event] = await tx
      .insert(mergeEvent)
      .values({
        winnerId,
        loserId,
        mergedBy,
        snapshot,
      })
      .returning({ id: mergeEvent.id })

    await tx.insert(activity).values({
      actorId: mergedBy,
      verb: 'entity.merged',
      subjectEntityId: winnerId,
      objectEntityId: loserId,
      meta: { mergeEventId: event.id },
    })

    return { mergeEventId: event.id }
  })
}
