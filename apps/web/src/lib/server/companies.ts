import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entityAlias,
  entitySpace,
  link,
  person,
  space,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { addIdentityAlias, resolveEntity } from '../entities/resolve'
import { jsonString } from '#/lib/json'
import { lastTouchedMap, requireUser } from './shared'
import type { SetValuesResult } from '../attributes/values'

export const listCompanies = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      sourceClass: entity.sourceClass,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(and(eq(entity.kind, 'company'), isNull(entity.mergedIntoId)))
    .orderBy(desc(entity.createdAt))

  if (rows.length === 0) return []

  // Primary domain per company, one query.
  const domains = await db
    .select({
      entityId: entityAlias.entityId,
      domain: entityAlias.valueNorm,
    })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.kind, 'domain'), eq(entityAlias.isIdentity, true)),
    )
  const domainByEntity = new Map(domains.map((d) => [d.entityId, d.domain]))

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    domain: domainByEntity.get(r.id) ?? null,
  }))
})

const createCompanyInput = z
  .object({
    name: z.string().trim().max(160).optional(),
    domain: z.string().trim().max(255).optional(),
    /** attribute values set in the create dialog — win over defaults */
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => v.name || v.domain, {
    message: 'Give a name or a domain',
  })

export const createCompany = createServerFn({ method: 'POST' })
  .validator(createCompanyInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const result = await resolveEntity({
      kind: 'company',
      ...(data.name ? { name: data.name } : {}),
      ...(data.domain ? { keys: { domain: data.domain } } : {}),
      source: { class: 'manual' },
      createdBy: u.id,
      values: data.values,
    })

    if (result.action === 'created') {
      await db.insert(activity).values({
        actorId: u.id,
        verb: 'company.created',
        subjectEntityId: result.entityId,
      })
    }

    const [row] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, result.entityId))
    return { ...result, name: row.name }
  })

/** Table rows: entity core + values + domains + spaces, one query batch. */
export const listCompaniesTable = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .innerJoin(company, eq(company.entityId, entity.id))
    .where(and(eq(entity.kind, 'company'), isNull(entity.mergedIntoId)))
    .orderBy(desc(entity.createdAt))

  const domains = await db
    .select({ entityId: entityAlias.entityId, domain: entityAlias.valueNorm })
    .from(entityAlias)
    .where(
      and(eq(entityAlias.kind, 'domain'), eq(entityAlias.isIdentity, true)),
    )
  const domainsBy = new Map<string, Array<string>>()
  for (const d of domains) {
    domainsBy.set(d.entityId, [...(domainsBy.get(d.entityId) ?? []), d.domain])
  }

  const tags = await db
    .select({
      entityId: entitySpace.entityId,
      spaceId: entitySpace.spaceId,
      spaceName: entity.canonicalName,
    })
    .from(entitySpace)
    .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
  const spacesBy = new Map<string, Array<{ id: string; name: string }>>()
  for (const t of tags) {
    spacesBy.set(t.entityId, [
      ...(spacesBy.get(t.entityId) ?? []),
      { id: t.spaceId, name: t.spaceName },
    ])
  }

  const touched = await lastTouchedMap()

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    values: r.values,
    domains: domainsBy.get(r.id) ?? [],
    spaces: spacesBy.get(r.id) ?? [],
    lastTouched: touched[r.id] ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
})

export const getCompany = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()

    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          sourceClass: entity.sourceClass,
          mergedIntoId: entity.mergedIntoId,
          createdAt: entity.createdAt,
          values: entity.values,
        })
        .from(entity)
        .innerJoin(company, eq(company.entityId, entity.id))
        .where(eq(entity.id, data.id))
    ).at(0)
    if (!head) throw new Error('Company not found')

    const aliases = await db
      .select({
        id: entityAlias.id,
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
        isIdentity: entityAlias.isIdentity,
        sourceClass: entityAlias.sourceClass,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, data.id))

    const spaces = await db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        source: entitySpace.source,
      })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(entitySpace.entityId, data.id))

    // Contacts: people linked contact_at → this company.
    const peopleRows = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .innerJoin(person, eq(person.entityId, entity.id))
      .where(
        and(
          eq(link.toEntityId, data.id),
          eq(link.relation, 'contact_at'),
          isNull(entity.mergedIntoId),
        ),
      )
    const people = peopleRows.map((p) => ({
      id: p.id,
      name: p.name,
      headline: jsonString(p.values.job_title),
    }))

    // Notes (and anything else) that mention this company.
    const mentionedIn = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))

    const timeline = await db
      .select({
        id: activity.id,
        verb: activity.verb,
        actorId: activity.actorId,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.id))
      .orderBy(desc(activity.at))
      .limit(50)

    return {
      id: head.id,
      name: head.name,
      sourceClass: head.sourceClass,
      mergedIntoId: head.mergedIntoId,
      createdAt: head.createdAt.toISOString(),
      values: head.values,
      aliases,
      spaces,
      people,
      mentionedIn,
      timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
    }
  })

/**
 * Generic record update for object-model entities: rename and/or an
 * attribute-values patch through the one validated write path.
 */
export const updateRecord = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200).optional(),
      patch: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    // Empty until the patch half runs: a rename asserts no identity key, so
    // a name-only update truthfully reports no outcomes rather than none.
    let identity: SetValuesResult['identity'] = {}
    let identityValues: SetValuesResult['identityValues'] = {}
    if (data.name) {
      // The rename half is Effect-first through the effectFn seam
      // (backend-paradigm ratchet); the values patch below is untouched and
      // stays Promise-shaped until it is open for behavioural change.
      const { effectFn } = await import('./effect')
      const { renameRecordProgram } = await import('../entities/rename')
      await effectFn(renameRecordProgram)(u.id, {
        id: data.id,
        name: data.name,
      })
    }
    if (data.patch && Object.keys(data.patch).length > 0) {
      const { setValues } = await import('../attributes/values')
      // The identity outcome is the only thing this call returns that the
      // client cannot recompute: the claim was decided inside the write's
      // transaction. Threaded out so the editing surfaces can say so
      // (SPA-97) — the write itself is unchanged.
      const result = await setValues({
        entityId: data.id,
        patch: data.patch,
        actor: { type: 'user', id: u.id },
      })
      identity = result.identity
      identityValues = result.identityValues
      // The pipeline→portfolio seam: a deal reaching Invested births a
      // holding (idempotent — follow-ons land on the existing one).
      if (data.patch.stage === 'invested') {
        const row = (
          await db
            .select({ kind: entity.kind, values: entity.values })
            .from(entity)
            .where(eq(entity.id, data.id))
        ).at(0)
        const companyId = row ? jsonString(row.values.company) : null
        if (row?.kind === 'deal' && companyId !== null) {
          const { birthHolding } = await import('./shared')
          await birthHolding({ companyId, actorId: u.id })
        }
      }
    }
    return { ok: true, identity, identityValues }
  })

/** Surfaces the dedupe tripwire in the UI. */
export const addCompanyDomain = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), domain: z.string().max(255) }))
  .handler(async ({ data }) => {
    await requireUser()
    const result = await addIdentityAlias(data.id, 'domain', data.domain, {
      class: 'manual',
    })
    return result
  })

export const tagIntoSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({ entityId: z.string().uuid(), spaceId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .insert(entitySpace)
      .values({
        entityId: data.entityId,
        spaceId: data.spaceId,
        source: 'manual',
        createdBy: u.id,
      })
      .onConflictDoNothing()
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'space.tagged',
      subjectEntityId: data.entityId,
      objectEntityId: data.spaceId,
    })
    return { ok: true }
  })

export const untagFromSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({ entityId: z.string().uuid(), spaceId: z.string().uuid() }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db
      .delete(entitySpace)
      .where(
        and(
          eq(entitySpace.entityId, data.entityId),
          eq(entitySpace.spaceId, data.spaceId),
        ),
      )
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'space.untagged',
      subjectEntityId: data.entityId,
      objectEntityId: data.spaceId,
    })
    return { ok: true }
  })
