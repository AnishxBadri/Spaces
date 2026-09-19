import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  duplicateCandidate,
  entity,
  entityAlias,
  entitySpace,
  link,
} from '@spaces/db/schema'
import { normalizeName } from '@spaces/core/entities/normalize'
import { mergeEntities } from '../entities/merge'
import { provenanceOf, requireUser } from './shared'

export async function entityContext(id: string) {
  const [head] = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      kind: entity.kind,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(eq(entity.id, id))
  // Provenance is the pair now, and the pair is only half an answer on its
  // own: "integration" names no integration. `provenanceOf` resolves the
  // ref to the capability id the operator installed.
  const provenance = await provenanceOf(id)
  const aliases = await db
    .select({ kind: entityAlias.kind, valueNorm: entityAlias.valueNorm })
    .from(entityAlias)
    .where(eq(entityAlias.entityId, id))
  const [{ value: mentionCount }] = await db
    .select({ value: count() })
    .from(link)
    .where(and(eq(link.toEntityId, id), eq(link.relation, 'mentions')))
  const spaceRows = await db
    .select({ name: entity.canonicalName })
    .from(entitySpace)
    .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
    .where(eq(entitySpace.entityId, id))
  return {
    ...head,
    ...provenance,
    createdAt: head.createdAt.toISOString(),
    domains: aliases.filter((a) => a.kind === 'domain').map((a) => a.valueNorm),
    // "Other" is measured in the same normal form the aliases are written
    // in — `normalizeName`, not lowercase. Lowercasing leaves the legal
    // suffix on ("acme inc" vs the alias "acme"), so a record would list
    // its own current name as something it was also seen as. Renames write
    // a name alias now (SPA-63), so every record has that row.
    otherNames: aliases
      .filter(
        (a) => a.kind === 'name' && a.valueNorm !== normalizeName(head.name),
      )
      .map((a) => a.valueNorm),
    mentionCount,
    spaces: spaceRows.map((s) => s.name),
  }
}

export const listDuplicates = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select()
    .from(duplicateCandidate)
    .where(eq(duplicateCandidate.status, 'open'))
    .orderBy(desc(duplicateCandidate.score), desc(duplicateCandidate.createdAt))
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      score: r.score,
      reason: r.reason,
      a: await entityContext(r.entityA),
      b: await entityContext(r.entityB),
    })),
  )
})

export const countOpenDuplicates = createServerFn().handler(async () => {
  await requireUser()
  const [{ value }] = await db
    .select({ value: count() })
    .from(duplicateCandidate)
    .where(eq(duplicateCandidate.status, 'open'))
  return { open: value }
})

export const mergeDuplicate = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      candidateId: z.string().uuid(),
      winnerId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const cand = (
      await db
        .select()
        .from(duplicateCandidate)
        .where(eq(duplicateCandidate.id, data.candidateId))
    ).at(0)
    if (!cand || cand.status !== 'open') throw new Error('Candidate not open')
    if (data.winnerId !== cand.entityA && data.winnerId !== cand.entityB)
      throw new Error('Winner must be one of the pair')
    const loserId = data.winnerId === cand.entityA ? cand.entityB : cand.entityA
    await mergeEntities({
      winnerId: data.winnerId,
      loserId,
      mergedBy: u.id,
      candidateId: data.candidateId,
    })
    return { ok: true }
  })

export const dismissDuplicate = createServerFn({ method: 'POST' })
  .validator(z.object({ candidateId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .update(duplicateCandidate)
      .set({ status: 'dismissed', resolvedBy: u.id, resolvedAt: new Date() })
      .where(eq(duplicateCandidate.id, data.candidateId))
    return { ok: true }
  })
