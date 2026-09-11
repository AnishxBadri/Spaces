import { and, eq, getTableColumns, or, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '#/db'
import { ENTITY_REFS } from '#/db/entity-refs'
import type { EntityRef } from '#/db/entity-refs'
import {
  attributeEvent,
  duplicateCandidate,
  entity,
  entityAlias,
  link,
  mergeEvent,
} from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { distribution, holding, investment, mark } from '#/db/schema/portfolio'

/**
 * Merge executor, per CONTEXT.md: repoint at write time, resolve nothing at
 * read time. Loser survives as a redirect (merged_into_id); every moved or
 * dropped row lands in merge_event.snapshot so unmerge stays possible.
 *
 * Restricted to company|person|organization and same-kind pairs — spaces
 * and notes have structural children and different semantics.
 */

type SnapshotEntry = {
  table: string
  action:
    'repointed' | 'dropped' | 'field_filled' | 'field_conflict' | 'inserted'
  pk: Record<string, unknown>
  old: Record<string, unknown>
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const MERGEABLE = new Set(['company', 'person', 'organization'])

/**
 * The merge executor's value rewrites (fills, reference repoints) get an
 * attribute_event like any other write — actor `system`, door `merge` —
 * so the timeline never shows them as a teammate's edit. Inserted rows go
 * in the snapshot: the snapshot convention is the only unmerge contract.
 */
async function logMergeEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  snapshot: Array<SnapshotEntry>,
  change: { entityId: string; attrSlug: string; from: unknown; to: unknown },
) {
  const [ev] = await tx
    .insert(attributeEvent)
    .values({
      entityId: change.entityId,
      attrSlug: change.attrSlug,
      from: change.from,
      to: change.to,
      actorType: 'system',
      actorId: null,
      source: 'merge',
    })
    .returning({ id: attributeEvent.id })
  snapshot.push({
    table: 'attribute_event',
    action: 'inserted',
    pk: { id: ev.id },
    old: {},
  })
}

/**
 * Custom merge sections implemented below, by the handler name the registry
 * declares. Checked at import so a registry entry naming a handler nobody
 * wrote fails the first test that loads this module.
 */
const CUSTOM_HANDLERS = new Set([
  'aliases',
  'redirect',
  'links',
  'holdings',
  'candidates',
])
for (const ref of ENTITY_REFS) {
  if (ref.merge.kind === 'custom' && !CUSTOM_HANDLERS.has(ref.merge.handler))
    throw new Error(
      `ENTITY_REFS ${ref.key}: custom merge handler '${ref.merge.handler}' has no section in merge.ts`,
    )
}

/** TS property name for a column (snapshots use property names, not SQL). */
function propertyKey(table: PgTable, column: PgColumn): string {
  const hit = Object.entries(
    getTableColumns(table) as Record<string, PgColumn>,
  ).find(([, c]) => c.name === column.name)
  if (!hit) throw new Error(`column ${column.name} not on table`)
  return hit[0]
}

/**
 * The generic strategies. `repoint` is a plain update. `repoint-or-drop`
 * first checks whether the winner already holds the row's unique partner
 * (same space, same interaction, same task, same round) and drops the
 * loser's row instead of colliding. Composite primary keys are addressed by
 * their column values, so this works for id-less join tables too.
 */
async function repointGeneric(
  tx: Tx,
  ref: EntityRef,
  loserId: string,
  winnerId: string,
  snapshot: Array<SnapshotEntry>,
): Promise<void> {
  const cfg = getTableConfig(ref.table)
  const pkCols =
    cfg.primaryKeys[0]?.columns ?? cfg.columns.filter((c) => c.primary)
  const keyOf = (c: PgColumn) => propertyKey(ref.table, c)
  const colKey = keyOf(ref.column)
  const rows = await tx.select().from(ref.table).where(eq(ref.column, loserId))
  for (const row of rows) {
    const pk = Object.fromEntries(pkCols.map((c) => [keyOf(c), row[keyOf(c)]]))
    const rowWhere = and(...pkCols.map((c) => eq(c, row[keyOf(c)])))
    let collides = false
    if (ref.merge.kind === 'repoint-or-drop') {
      const partner = ref.merge.uniqueWith.map((c) => eq(c, row[keyOf(c)]))
      collides =
        (
          await tx
            .select({ one: sql`1` })
            .from(ref.table)
            .where(and(eq(ref.column, winnerId), ...partner))
            .limit(1)
        ).length > 0
    }
    if (collides) {
      snapshot.push({ table: cfg.name, action: 'dropped', pk, old: row })
      await tx.delete(ref.table).where(rowWhere)
    } else {
      snapshot.push({
        table: cfg.name,
        action: 'repointed',
        pk,
        old: { [colKey]: loserId },
      })
      await tx
        .update(ref.table)
        .set({ [colKey]: winnerId })
        .where(rowWhere)
    }
  }
}

export async function mergeEntities(opts: {
  winnerId: string
  loserId: string
  mergedBy: string
  candidateId?: string
}): Promise<{ mergeEventId: string }> {
  const { winnerId, loserId, mergedBy } = opts
  if (winnerId === loserId)
    throw new Error('Cannot merge an entity into itself')

  return db.transaction(async (tx) => {
    const winner = (
      await tx
        .select({
          id: entity.id,
          kind: entity.kind,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(eq(entity.id, winnerId))
    ).at(0)
    const loser = (
      await tx
        .select({
          id: entity.id,
          kind: entity.kind,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(eq(entity.id, loserId))
    ).at(0)
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
          old: a,
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

    // --- links: repoint both directions; unique(from,to,relation,attr) ----
    const loserLinks = await tx
      .select()
      .from(link)
      .where(or(eq(link.fromEntityId, loserId), eq(link.toEntityId, loserId)))
    // Record-reference attributes pointing AT the loser: after repointing
    // the links, the referrers' values jsonb must be rewritten too.
    const inboundRefs = loserLinks.filter(
      (l) => l.relation === 'references' && l.toEntityId === loserId,
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

    // --- every generic edge column: one loop over the registry ------------
    for (const ref of ENTITY_REFS) {
      if (ref.merge.kind === 'repoint' || ref.merge.kind === 'repoint-or-drop')
        await repointGeneric(tx, ref, loserId, winnerId, snapshot)
    }

    // --- attribute values: winner keeps, loser fills the gaps -------------
    {
      const w = (
        await tx
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, winnerId))
      ).at(0)
      const l = (
        await tx
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, loserId))
      ).at(0)
      const wv = (w?.values ?? {}) as Record<string, unknown>
      const lv = (l?.values ?? {}) as Record<string, unknown>
      const fill: Record<string, unknown> = {}
      for (const [key, loserVal] of Object.entries(lv)) {
        if (loserVal == null) continue
        const winnerVal = wv[key]
        if (
          winnerVal == null ||
          (Array.isArray(winnerVal) && winnerVal.length === 0)
        ) {
          fill[key] = loserVal
          snapshot.push({
            table: 'entity.values',
            action: 'field_filled',
            pk: { entityId: winnerId },
            old: {
              field: key,
              winnerHad: winnerVal ?? null,
              filledWith: loserVal,
            },
          })
        } else if (JSON.stringify(winnerVal) !== JSON.stringify(loserVal)) {
          snapshot.push({
            table: 'entity.values',
            action: 'field_conflict',
            pk: { entityId: winnerId },
            old: { field: key, winnerKept: winnerVal, loserHad: loserVal },
          })
        }
      }
      if (Object.keys(fill).length > 0) {
        await tx
          .update(entity)
          .set({ values: { ...wv, ...fill } })
          .where(eq(entity.id, winnerId))
        // History stays honest: a fill is a value change nobody asserted,
        // logged as the system's, through the merge door (typed actor,
        // spec §4). Snapshotted so unmerge can drop the rows again.
        for (const [key, filledWith] of Object.entries(fill)) {
          await logMergeEvent(tx, snapshot, {
            entityId: winnerId,
            attrSlug: key,
            from: wv[key] ?? null,
            to: filledWith,
          })
        }
      }
    }

    // --- referrers' record-reference values: loser id → winner id ---------
    for (const ref of inboundRefs) {
      const referrer = (
        await tx
          .select({ values: entity.values })
          .from(entity)
          .where(eq(entity.id, ref.fromEntityId))
      ).at(0)
      if (!referrer) continue
      const vals = { ...(referrer.values ?? {}) } as Record<string, unknown>
      const cur = vals[ref.attrSlug]
      let nextVal: unknown = cur
      if (cur === loserId) nextVal = winnerId
      else if (Array.isArray(cur)) {
        nextVal = [...new Set(cur.map((v) => (v === loserId ? winnerId : v)))]
      }
      if (JSON.stringify(nextVal) !== JSON.stringify(cur)) {
        snapshot.push({
          table: 'entity.values',
          action: 'repointed',
          pk: { entityId: ref.fromEntityId },
          old: { field: ref.attrSlug, was: cur },
        })
        vals[ref.attrSlug] = nextVal
        await tx
          .update(entity)
          .set({ values: vals })
          .where(eq(entity.id, ref.fromEntityId))
        await logMergeEvent(tx, snapshot, {
          entityId: ref.fromEntityId,
          attrSlug: ref.attrSlug,
          from: cur ?? null,
          to: nextVal,
        })
      }
    }

    // --- portfolio: holdings collapse onto the winner ---------------------
    // One holding per company is doctrine; when both sides hold, the
    // loser's events move onto the winner's holding and the loser holding
    // row is dropped — cross-entity follow-ons land on one holding.
    const loserHolding = (
      await tx
        .select({ id: holding.id })
        .from(holding)
        .where(eq(holding.companyId, loserId))
    ).at(0)
    if (loserHolding) {
      const winnerHolding = (
        await tx
          .select({ id: holding.id })
          .from(holding)
          .where(eq(holding.companyId, winnerId))
      ).at(0)
      if (winnerHolding) {
        for (const [tbl, name] of [
          [investment, 'investment'],
          [mark, 'mark'],
          [distribution, 'distribution'],
        ] as const) {
          for (const row of await tx
            .select({ id: tbl.id })
            .from(tbl)
            .where(eq(tbl.holdingId, loserHolding.id))) {
            snapshot.push({
              table: name,
              action: 'repointed',
              pk: { id: row.id },
              old: { holdingId: loserHolding.id },
            })
          }
          await tx
            .update(tbl)
            .set({ holdingId: winnerHolding.id })
            .where(eq(tbl.holdingId, loserHolding.id))
        }
        snapshot.push({
          table: 'holding',
          action: 'dropped',
          pk: { id: loserHolding.id },
          old: { companyId: loserId },
        })
        await tx.delete(holding).where(eq(holding.id, loserHolding.id))
      } else {
        snapshot.push({
          table: 'holding',
          action: 'repointed',
          pk: { id: loserHolding.id },
          old: { companyId: loserId },
        })
        await tx
          .update(holding)
          .set({ companyId: winnerId })
          .where(eq(holding.id, loserHolding.id))
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
        old: c,
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
