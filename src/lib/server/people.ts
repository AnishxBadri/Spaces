import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { entity, entityAlias, link, person } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { addIdentityAlias, resolveEntity } from '../entities/resolve'
import { jsonString } from '#/lib/json'
import { lastTouchedMap, requireUser } from './shared'

export const listPeople = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .innerJoin(person, eq(person.entityId, entity.id))
    .where(isNull(entity.mergedIntoId))
    .orderBy(desc(entity.createdAt))
  if (rows.length === 0) return []

  // Primary email + company per person, batched.
  const emails = await db
    .select({ entityId: entityAlias.entityId, email: entityAlias.valueNorm })
    .from(entityAlias)
    .where(and(eq(entityAlias.kind, 'email'), eq(entityAlias.isIdentity, true)))
  const emailBy = new Map(emails.map((e) => [e.entityId, e.email]))

  const companies = await db
    .select({
      personId: link.fromEntityId,
      companyId: entity.id,
      companyName: entity.canonicalName,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(eq(link.relation, 'contact_at'))
  const companyBy = new Map(
    companies.map((c) => [
      c.personId,
      { id: c.companyId, name: c.companyName },
    ]),
  )

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    headline: jsonString(r.values.job_title),
    email: emailBy.get(r.id) ?? null,
    company: companyBy.get(r.id) ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
})

/** Table rows for people: values + identity emails + company via contact_at. */
export const listPeopleTable = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .innerJoin(person, eq(person.entityId, entity.id))
    .where(isNull(entity.mergedIntoId))
    .orderBy(desc(entity.createdAt))

  const emails = await db
    .select({ entityId: entityAlias.entityId, email: entityAlias.valueNorm })
    .from(entityAlias)
    .where(and(eq(entityAlias.kind, 'email'), eq(entityAlias.isIdentity, true)))
  const emailsBy = new Map<string, Array<string>>()
  for (const e of emails) {
    emailsBy.set(e.entityId, [...(emailsBy.get(e.entityId) ?? []), e.email])
  }

  const companies = await db
    .select({
      personId: link.fromEntityId,
      companyId: entity.id,
      companyName: entity.canonicalName,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(and(eq(link.relation, 'contact_at'), isNull(entity.mergedIntoId)))
  const companyBy = new Map<string, { id: string; name: string }>()
  for (const c of companies) {
    companyBy.set(c.personId, { id: c.companyId, name: c.companyName })
  }

  const touched = await lastTouchedMap()

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    values: r.values,
    emails: emailsBy.get(r.id) ?? [],
    company: companyBy.get(r.id) ?? null,
    lastTouched: touched[r.id] ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
})

const createPersonInput = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(255).optional(),
  companyId: z.string().uuid().optional(),
  /** attribute values set in the create dialog — win over defaults */
  values: z.record(z.string(), z.unknown()).optional(),
})

export const createPerson = createServerFn({ method: 'POST' })
  .validator(createPersonInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const result = await resolveEntity({
      kind: 'person',
      name: data.name,
      keys: data.email ? { email: data.email } : undefined,
      source: 'manual',
      createdBy: u.id,
      values: data.values,
    })
    if (data.companyId) {
      await db
        .insert(link)
        .values({
          fromEntityId: result.entityId,
          toEntityId: data.companyId,
          relation: 'contact_at',
          source: 'manual',
          createdBy: u.id,
        })
        .onConflictDoNothing()
    }
    if (result.action === 'created') {
      await db.insert(activity).values({
        actorId: u.id,
        verb: 'person.created',
        subjectEntityId: result.entityId,
      })
    }
    const [row] = await db
      .select({ name: entity.canonicalName })
      .from(entity)
      .where(eq(entity.id, result.entityId))
    return { ...result, name: row.name }
  })

export const getPerson = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          mergedIntoId: entity.mergedIntoId,
          createdAt: entity.createdAt,
          values: entity.values,
        })
        .from(entity)
        .innerJoin(person, eq(person.entityId, entity.id))
        .where(eq(entity.id, data.id))
    ).at(0)
    if (!head) throw new Error('Person not found')

    const aliases = await db
      .select({
        id: entityAlias.id,
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
      })
      .from(entityAlias)
      .where(eq(entityAlias.entityId, data.id))

    const companies = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(
          eq(link.fromEntityId, data.id),
          eq(link.relation, 'contact_at'),
          isNull(entity.mergedIntoId),
        ),
      )

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
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.id))
      .orderBy(desc(activity.at))
      .limit(50)

    return {
      id: head.id,
      name: head.name,
      mergedIntoId: head.mergedIntoId,
      values: head.values,
      emails: aliases.filter((a) => a.kind === 'email'),
      linkedins: aliases.filter((a) => a.kind === 'linkedin'),
      companies,
      mentionedIn,
      timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
    }
  })

/** Email/LinkedIn add with the same tripwire semantics as company domains. */
export const addPersonContact = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      kind: z.enum(['email', 'linkedin']),
      value: z.string().trim().max(255),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    return addIdentityAlias(data.id, data.kind, data.value, 'manual')
  })

export const setPersonCompany = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      personId: z.string().uuid(),
      companyId: z.string().uuid(),
      action: z.enum(['link', 'unlink']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (data.action === 'link') {
      await db
        .insert(link)
        .values({
          fromEntityId: data.personId,
          toEntityId: data.companyId,
          relation: 'contact_at',
          source: 'manual',
          createdBy: u.id,
        })
        .onConflictDoNothing()
    } else {
      await db
        .delete(link)
        .where(
          and(
            eq(link.fromEntityId, data.personId),
            eq(link.toEntityId, data.companyId),
            eq(link.relation, 'contact_at'),
          ),
        )
    }
    return { ok: true }
  })
