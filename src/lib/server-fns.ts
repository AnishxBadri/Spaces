import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { auth } from './auth'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
import {
  company,
  document,
  documentChunk,
  duplicateCandidate,
  entity,
  entityAlias,
  entitySpace,
  interaction,
  interactionEntity,
  link,
  note,
  person,
  space,
  term,
  thesis,
  thesisSpace,
} from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { addIdentityAlias, resolveEntity } from './entities/resolve'
import { mergeEntities } from './entities/merge'
import { storeCredential } from './vault'
import { DOCUMENT_KINDS, MAX_UPLOAD_BYTES } from './documents'
import { enqueue } from './queue'
import { storage } from './storage'
import { QUEUES } from '#/worker/queues'

/**
 * Server functions consumed by route loaders and forms. Auth checks happen
 * here — never trust the client to have done them.
 */

/** Closed JSON type — Start's serializer rejects `unknown`. */
type Json = string | number | boolean | null | Array<Json> | { [k: string]: Json }

export const getSession = createServerFn().handler(async () => {
  const session = await auth.api.getSession({
    headers: getRequest().headers,
  })
  if (!session) return null
  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: session.user.role,
    },
  }
})

/** True until the first admin exists — drives the /setup redirect. */
export const getSetupState = createServerFn().handler(async () => {
  const [{ value }] = await db.select({ value: count() }).from(user)
  return { needsSetup: value === 0 }
})

async function requireUser() {
  const session = await auth.api.getSession({
    headers: getRequest().headers,
  })
  if (!session) throw new Error('Unauthorized')
  return session.user
}

const aiKeyInput = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'ollama']),
  key: z.string().min(1).max(500),
  baseUrl: z.string().url().optional(),
})

export const saveAiKey = createServerFn({ method: 'POST' })
  .validator(aiKeyInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (u.role !== 'admin') throw new Error('Admins only')
    const { display } = await storeCredential({
      scope: 'workspace',
      provider: data.provider,
      kind: 'llm',
      secret: data.key,
      meta: data.baseUrl ? { baseUrl: data.baseUrl } : {},
      createdBy: u.id,
    })
    return { display }
  })

// ---------- companies ----------

export const listCompanies = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      source: entity.source,
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
      name: data.name || undefined,
      keys: data.domain ? { domain: data.domain } : undefined,
      source: 'manual',
      createdBy: u.id,
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

// ---------- attribute registry ----------

export const listRegistry = createServerFn()
  .validator(
    z.object({
      kind: z.enum(['company', 'person', 'deal']),
      includeArchived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { attribute } = await import('#/db/schema')
    const rows = await db
      .select()
      .from(attribute)
      .where(
        data.includeArchived
          ? eq(attribute.objectKind, data.kind)
          : and(
              eq(attribute.objectKind, data.kind),
              eq(attribute.archived, false),
            ),
      )
      .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
    return rows.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      type: d.type,
      options: d.options as Json,
      isSystem: d.isSystem,
      archived: d.archived,
      sortOrder: d.sortOrder,
    }))
  })

const optionEdit = z.object({
  /** absent id = new option (id derived from label) */
  id: z.string().max(60).optional(),
  label: z.string().trim().min(1).max(60),
  group: z.enum(['active', 'parked', 'closed']).optional(),
})

/**
 * Attribute maintenance. Structure fixed, content free: names and options
 * are editable (system included); types never change; options can be added
 * and renamed but not removed — stored values may reference them.
 */
export const updateAttribute = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(80).optional(),
      archived: z.boolean().optional(),
      move: z.enum(['up', 'down']).optional(),
      options: z.array(optionEdit).max(50).optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { attribute } = await import('#/db/schema')
    const [attr] = await db
      .select()
      .from(attribute)
      .where(eq(attribute.id, data.id))
    if (!attr) throw new Error('Attribute not found')

    if (data.options) {
      const isOptionType = ['select', 'multi_select', 'status'].includes(
        attr.type,
      )
      if (!isOptionType) throw new Error('This attribute type has no options')
      const existing =
        ((attr.options as Record<string, unknown>).options as Array<{
          id: string
        }>) ?? []
      const existingIds = new Set(existing.map((o) => o.id))
      const keptIds = new Set(
        data.options.filter((o) => o.id).map((o) => o.id!),
      )
      for (const id of existingIds) {
        if (!keptIds.has(id))
          throw new Error(
            'Options cannot be removed — records may hold that value. Rename it instead.',
          )
      }
      const seen = new Set<string>()
      const nextOptions = data.options.map((o) => {
        let id = o.id
        if (!id) {
          id =
            o.label
              .toLowerCase()
              .normalize('NFKD')
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 48) || 'option'
          while (seen.has(id) || existingIds.has(id)) id = `${id}_2`
        }
        seen.add(id)
        return { id, label: o.label, ...(o.group ? { group: o.group } : {}) }
      })
      await db
        .update(attribute)
        .set({
          options: {
            ...(attr.options as Record<string, unknown>),
            options: nextOptions,
          },
        })
        .where(eq(attribute.id, data.id))
    }

    if (data.name) {
      await db
        .update(attribute)
        .set({ name: data.name })
        .where(eq(attribute.id, data.id))
    }
    if (data.archived !== undefined) {
      await db
        .update(attribute)
        .set({ archived: data.archived })
        .where(eq(attribute.id, data.id))
    }
    if (data.move) {
      const siblings = await db
        .select({ id: attribute.id, sortOrder: attribute.sortOrder })
        .from(attribute)
        .where(eq(attribute.objectKind, attr.objectKind))
        .orderBy(asc(attribute.sortOrder), asc(attribute.createdAt))
      const idx = siblings.findIndex((s) => s.id === data.id)
      const swapWith = data.move === 'up' ? siblings[idx - 1] : siblings[idx + 1]
      if (swapWith) {
        await db
          .update(attribute)
          .set({ sortOrder: swapWith.sortOrder })
          .where(eq(attribute.id, data.id))
        await db
          .update(attribute)
          .set({ sortOrder: attr.sortOrder })
          .where(eq(attribute.id, swapWith.id))
      }
    }
    return { ok: true }
  })

const createAttributeInput = z.object({
  objectKind: z.enum(['company', 'person', 'deal']),
  name: z.string().trim().min(1).max(80),
  type: z.enum([
    'text',
    'number',
    'currency',
    'date',
    'checkbox',
    'select',
    'multi_select',
    'rating',
    'url',
    'email',
    'phone',
  ]),
  /** select/multi_select: option labels; ids derived */
  optionLabels: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
})

export const createAttribute = createServerFn({ method: 'POST' })
  .validator(createAttributeInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { attribute } = await import('#/db/schema')

    const baseSlug =
      data.name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'attribute'

    // Suffix on slug collision within the object kind.
    let slug = baseSlug
    for (let i = 2; ; i++) {
      const existing = await db
        .select({ id: attribute.id })
        .from(attribute)
        .where(
          and(
            eq(attribute.objectKind, data.objectKind),
            eq(attribute.slug, slug),
          ),
        )
      if (existing.length === 0) break
      slug = `${baseSlug}_${i}`
    }

    const needsOptions = data.type === 'select' || data.type === 'multi_select'
    if (needsOptions && (!data.optionLabels || data.optionLabels.length === 0)) {
      throw new Error('Select attributes need at least one option')
    }
    const options = needsOptions
      ? {
          options: data.optionLabels!.map((label) => ({
            id:
              label
                .toLowerCase()
                .normalize('NFKD')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 48) || 'option',
            label,
          })),
        }
      : data.type === 'rating'
        ? { max: 5 }
        : {}

    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`coalesce(max(${attribute.sortOrder}), 0)` })
      .from(attribute)
      .where(eq(attribute.objectKind, data.objectKind))

    const [row] = await db
      .insert(attribute)
      .values({
        objectKind: data.objectKind,
        slug,
        name: data.name,
        type: data.type,
        options,
        isSystem: false,
        sortOrder: maxOrder + 10,
        createdBy: u.id,
      })
      .returning({ id: attribute.id, slug: attribute.slug })
    return row
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
    .where(and(eq(entityAlias.kind, 'domain'), eq(entityAlias.isIdentity, true)))
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
    values: (r.values ?? {}) as Record<string, Json>,
    domains: domainsBy.get(r.id) ?? [],
    spaces: spacesBy.get(r.id) ?? [],
    lastTouched: touched[r.id] ?? null,
    createdAt: r.createdAt.toISOString(),
  }))
})

// ---------- company record ----------

export const getCompany = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()

    const [head] = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        source: entity.source,
        mergedIntoId: entity.mergedIntoId,
        createdAt: entity.createdAt,
        values: entity.values,
      })
      .from(entity)
      .innerJoin(company, eq(company.entityId, entity.id))
      .where(eq(entity.id, data.id))
    if (!head) throw new Error('Company not found')

    const aliases = await db
      .select({
        id: entityAlias.id,
        kind: entityAlias.kind,
        value: entityAlias.value,
        valueNorm: entityAlias.valueNorm,
        isIdentity: entityAlias.isIdentity,
        source: entityAlias.source,
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
      headline:
        (((p.values ?? {}) as Record<string, unknown>).job_title as string) ??
        null,
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
      source: head.source,
      mergedIntoId: head.mergedIntoId,
      createdAt: head.createdAt.toISOString(),
      values: (head.values ?? {}) as Record<string, Json>,
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
    if (data.name) {
      await db
        .update(entity)
        .set({ canonicalName: data.name })
        .where(eq(entity.id, data.id))
      await db.insert(activity).values({
        actorId: u.id,
        verb: 'renamed',
        subjectEntityId: data.id,
      })
    }
    if (data.patch && Object.keys(data.patch).length > 0) {
      const { setValues } = await import('./attributes/values')
      await setValues({ entityId: data.id, patch: data.patch, actorId: u.id })
    }
    return { ok: true }
  })

/** Surfaces the dedupe tripwire in the UI. */
export const addCompanyDomain = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid(), domain: z.string().max(255) }))
  .handler(async ({ data }) => {
    await requireUser()
    const result = await addIdentityAlias(
      data.id,
      'domain',
      data.domain,
      'manual',
    )
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

// ---------- people ----------

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
    .where(
      and(eq(entityAlias.kind, 'email'), eq(entityAlias.isIdentity, true)),
    )
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
    headline:
      ((r.values as Record<string, unknown>)?.job_title as string) ?? null,
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
    values: (r.values ?? {}) as Record<string, Json>,
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
    const [head] = await db
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
      values: (head.values ?? {}) as Record<string, Json>,
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

// ---------- deals ----------

const createDealInput = z.object({
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  stage: z.string().max(60).optional(),
  value: z.number().finite().optional(),
  source: z.string().max(60).optional(),
})

export const createDeal = createServerFn({ method: 'POST' })
  .validator(createDealInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'deal', canonicalName: data.name, createdBy: u.id })
      .returning({ id: entity.id })

    const { setValues } = await import('./attributes/values')
    await setValues({
      entityId: ent.id,
      patch: {
        company: data.companyId,
        stage: data.stage ?? 'pre_lead',
        owner: u.id,
        ...(data.value !== undefined ? { value: data.value } : {}),
        ...(data.source ? { source: data.source } : {}),
      },
      actorId: u.id,
    })
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'deal.created',
      subjectEntityId: data.companyId,
      objectEntityId: ent.id,
    })
    return { id: ent.id }
  })

/**
 * Deal rows with referenced records resolved for display: values hold
 * uuids; the table wants names. One pass over reference links.
 */
export const listDealsTable = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      values: entity.values,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(and(eq(entity.kind, 'deal'), isNull(entity.mergedIntoId)))
    .orderBy(desc(entity.createdAt))

  if (rows.length === 0)
    return {
      rows: [] as Array<{
        id: string
        name: string
        values: Record<string, Json>
        createdAt: string
      }>,
      refNames: {} as Record<string, { id: string; name: string; kind: string }>,
      userNames: {} as Record<string, string>,
    }
  const dealIds = rows.map((r) => r.id)
  const refs = await db
    .select({
      fromId: link.fromEntityId,
      toId: link.toEntityId,
      attrSlug: link.attrSlug,
      name: entity.canonicalName,
      kind: entity.kind,
    })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(eq(link.relation, 'references'), inArray(link.fromEntityId, dealIds)),
    )
  const refNames = new Map<string, { id: string; name: string; kind: string }>()
  for (const r of refs) refNames.set(r.toId, { id: r.toId, name: r.name, kind: r.kind })

  const users = await db.select({ id: user.id, name: user.name }).from(user)

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      values: (r.values ?? {}) as Record<string, Json>,
      createdAt: r.createdAt.toISOString(),
    })),
    refNames: Object.fromEntries(refNames) as Record<
      string,
      { id: string; name: string; kind: string }
    >,
    userNames: Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<
      string,
      string
    >,
  }
})

/** Deals referencing a company — the company record's Deals section. */
export const listCompanyDeals = createServerFn()
  .validator(z.object({ companyId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, data.companyId),
          eq(link.relation, 'references'),
          eq(link.attrSlug, 'company'),
          eq(entity.kind, 'deal'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(entity.createdAt))
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: ((r.values ?? {}) as Record<string, unknown>).stage as
        | string
        | undefined,
    }))
  })

export const getDeal = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [head] = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        mergedIntoId: entity.mergedIntoId,
        values: entity.values,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(and(eq(entity.id, data.id), eq(entity.kind, 'deal')))
    if (!head) throw new Error('Deal not found')

    // Resolve referenced entities + users for display.
    const refs = await db
      .select({
        toId: link.toEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .where(
        and(eq(link.fromEntityId, data.id), eq(link.relation, 'references')),
      )
    const users = await db.select({ id: user.id, name: user.name }).from(user)

    const mentionedIn = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))

    return {
      id: head.id,
      name: head.name,
      mergedIntoId: head.mergedIntoId,
      values: (head.values ?? {}) as Record<string, Json>,
      createdAt: head.createdAt.toISOString(),
      refNames: Object.fromEntries(
        refs.map((r) => [r.toId, { name: r.name, kind: r.kind }]),
      ) as Record<string, { name: string; kind: string }>,
      userNames: Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<
        string,
        string
      >,
      mentionedIn,
    }
  })

// ---------- interactions ----------

const logInteractionInput = z.object({
  kind: z.enum(['meeting', 'call']),
  subject: z.string().trim().min(1).max(300),
  occurredAt: z.string().datetime({ local: true }).or(z.string().datetime()),
  /** every entity in the room: people, companies, deals */
  attendeeIds: z.array(z.string().uuid()).min(1).max(50),
})

export const logInteraction = createServerFn({ method: 'POST' })
  .validator(logInteractionInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(interaction)
        .values({
          kind: data.kind,
          subject: data.subject,
          occurredAt: new Date(data.occurredAt),
        })
        .returning({ id: interaction.id })
      for (const entityId of new Set(data.attendeeIds)) {
        await tx
          .insert(interactionEntity)
          .values({ interactionId: row.id, entityId })
          .onConflictDoNothing()
      }
      await tx.insert(activity).values({
        actorId: u.id,
        verb: `interaction.${data.kind}`,
        subjectEntityId: data.attendeeIds[0],
        meta: { interactionId: row.id },
      })
      return { id: row.id }
    })
  })

/** Latest interaction per entity — the "last touched" signal for tables. */
async function lastTouchedMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({
      entityId: interactionEntity.entityId,
      last: sql<string>`max(${interaction.occurredAt})`,
    })
    .from(interactionEntity)
    .innerJoin(interaction, eq(interaction.id, interactionEntity.interactionId))
    .groupBy(interactionEntity.entityId)
  return Object.fromEntries(
    rows.map((r) => [r.entityId, new Date(r.last).toISOString()]),
  )
}

// ---------- documents ----------

/**
 * Upload is two calls around a direct-to-storage PUT, because a 200MB deck
 * must not stream through Node (CONTEXT.md → Storage). The client hashes the
 * file, asks for a URL, PUTs the bytes, then files the row. The blob route
 * re-verifies the digest, so a lying client fails at the store, not here.
 */

const shaKey = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Blob keys are sha256 hex digests')

export const prepareDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sha: shaKey,
      sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const store = storage()
    // Content-addressed: the same deck sent to both partners is one blob.
    // Already stored ⇒ skip the transfer entirely.
    if (await store.exists(data.sha)) {
      return { uploadUrl: null as string | null, alreadyStored: true }
    }
    return {
      uploadUrl: await store.getUploadUrl(data.sha, 600),
      alreadyStored: false,
    }
  })

export const finalizeDocumentUpload = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sha: shaKey,
      filename: z.string().trim().min(1).max(400),
      mime: z.string().max(200).nullish(),
      sizeBytes: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
      kind: z.enum(DOCUMENT_KINDS).default('other'),
      /** The record this document is filed against. */
      attachTo: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()

    // The bytes must actually be in the store: a client that skipped the PUT
    // would otherwise leave a document row pointing at nothing.
    if (!(await storage().exists(data.sha))) {
      throw new Error('Upload incomplete — the file never reached storage')
    }

    const [target] = await db
      .select({ id: entity.id, mergedIntoId: entity.mergedIntoId })
      .from(entity)
      .where(eq(entity.id, data.attachTo))
    if (!target) throw new Error('Record not found')
    if (target.mergedIntoId) throw new Error('That record has been merged away')

    // Same file, same record, twice — one row. Filing it again is almost
    // always a double-click or a re-drop, not a second document.
    const [existing] = await db
      .select({ id: document.entityId })
      .from(document)
      .innerJoin(link, eq(link.fromEntityId, document.entityId))
      .where(
        and(
          eq(document.blobSha, data.sha),
          eq(link.toEntityId, data.attachTo),
          eq(link.relation, 'tagged_in'),
        ),
      )
    if (existing) return { id: existing.id, deduped: true }

    const id = await db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({
          kind: 'document',
          canonicalName: data.filename,
          createdBy: u.id,
        })
        .returning({ id: entity.id })

      await tx.insert(document).values({
        entityId: ent.id,
        blobSha: data.sha,
        filename: data.filename,
        mime: data.mime ?? null,
        sizeBytes: data.sizeBytes,
        kind: data.kind,
        origin: 'upload',
        uploadedBy: u.id,
      })

      // Attachment goes through `link` — document.entity_id is the
      // document's own identity, not the record it belongs to.
      await tx.insert(link).values({
        fromEntityId: ent.id,
        toEntityId: data.attachTo,
        relation: 'tagged_in',
        source: 'manual',
        createdBy: u.id,
      })

      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'document.filed',
        subjectEntityId: data.attachTo,
        objectEntityId: ent.id,
        meta: { filename: data.filename, kind: data.kind },
      })

      return ent.id
    })

    // Outside the transaction: a queue that's down must not roll back a
    // perfectly good upload. The row stays 'pending' and can be re-queued.
    await enqueue(QUEUES.extractDocument, { documentId: id })

    return { id, deduped: false }
  })

/** Documents filed against a record — the Files tab. */
export const listRecordDocuments = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: document.entityId,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        kind: document.kind,
        origin: document.origin,
        extractionStatus: document.extractionStatus,
        extractionError: document.extractionError,
        createdAt: document.createdAt,
        uploadedBy: document.uploadedBy,
        // Enough text to prove extraction worked, without hauling a
        // 2MB column into every Files-tab render.
        snippet: sql<string | null>`left(${document.extractedText}, 200)`,
      })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(
        and(
          eq(link.toEntityId, data.entityId),
          eq(link.relation, 'tagged_in'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(document.createdAt))

    if (rows.length === 0) return []
    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const names = new Map(users.map((x) => [x.id, x.name]))

    return rows.map((r) => ({
      ...r,
      filename: r.filename ?? 'Untitled file',
      createdAt: r.createdAt.toISOString(),
      uploadedByName: r.uploadedBy ? (names.get(r.uploadedBy) ?? null) : null,
      snippet: r.snippet?.replace(/\s+/g, ' ').trim() || null,
    }))
  })

export const getDocumentDownloadUrl = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [row] = await db
      .select({ blobSha: document.blobSha, filename: document.filename })
      .from(document)
      .where(eq(document.entityId, data.id))
    if (!row?.blobSha) throw new Error('This document has no stored file')
    return {
      url: await storage().getDownloadUrl(row.blobSha, 300, {
        filename: row.filename ?? undefined,
      }),
    }
  })

/**
 * Real delete, not an archive flag: a misfiled upload the operator can't
 * remove is worse than the audit trail it costs. The blob only goes when no
 * other document row shares its digest — content-addressing means one file
 * can back several rows.
 */
export const deleteDocument = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [row] = await db
      .select({ blobSha: document.blobSha })
      .from(document)
      .where(eq(document.entityId, data.id))
    if (!row) return { ok: true }

    await db.transaction(async (tx) => {
      await tx
        .delete(documentChunk)
        .where(eq(documentChunk.documentId, data.id))
      await tx
        .delete(link)
        .where(
          or(eq(link.fromEntityId, data.id), eq(link.toEntityId, data.id)),
        )
      await tx
        .delete(activity)
        .where(
          or(
            eq(activity.subjectEntityId, data.id),
            eq(activity.objectEntityId, data.id),
          ),
        )
      await tx.delete(document).where(eq(document.entityId, data.id))
      await tx.delete(entity).where(eq(entity.id, data.id))
    })

    if (row.blobSha) {
      const [{ value: remaining }] = await db
        .select({ value: count() })
        .from(document)
        .where(eq(document.blobSha, row.blobSha))
      if (remaining === 0) await storage().delete(row.blobSha)
    }
    return { ok: true }
  })

// ---------- record timeline (condensed) ----------

/**
 * Merged timeline: macro activity + attribute_event bursts. Bursts group
 * consecutive attribute changes by the same actor within 10 minutes —
 * read-time condensing, per CONTEXT.md.
 */
export const getRecordTimeline = createServerFn()
  .validator(z.object({ entityId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { attributeEvent } = await import('#/db/schema')

    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const userNames = new Map(users.map((u) => [u.id, u.name]))

    const macros = await db
      .select({
        id: activity.id,
        verb: activity.verb,
        actorId: activity.actorId,
        at: activity.at,
      })
      .from(activity)
      .where(eq(activity.subjectEntityId, data.entityId))
      .orderBy(desc(activity.at))
      .limit(80)

    const events = await db
      .select()
      .from(attributeEvent)
      .where(eq(attributeEvent.entityId, data.entityId))
      .orderBy(desc(attributeEvent.at))
      .limit(200)

    const GAP_MS = 10 * 60 * 1000
    type Burst = {
      type: 'attrs'
      actor: string | null
      at: string
      changes: Array<{ slug: string; to: Json }>
    }
    const bursts: Array<Burst> = []
    for (const ev of events) {
      const last = bursts[bursts.length - 1]
      if (
        last &&
        last.actor === (ev.actorId ?? null) &&
        new Date(last.at).getTime() - ev.at.getTime() < GAP_MS
      ) {
        last.changes.push({ slug: ev.attrSlug, to: ev.to as Json })
      } else {
        bursts.push({
          type: 'attrs',
          actor: ev.actorId ?? null,
          at: ev.at.toISOString(),
          changes: [{ slug: ev.attrSlug, to: ev.to as Json }],
        })
      }
    }

    // Interactions this entity participated in, with co-attendees.
    const myInteractions = await db
      .select({
        id: interaction.id,
        kind: interaction.kind,
        subject: interaction.subject,
        occurredAt: interaction.occurredAt,
      })
      .from(interactionEntity)
      .innerJoin(
        interaction,
        eq(interaction.id, interactionEntity.interactionId),
      )
      .where(eq(interactionEntity.entityId, data.entityId))
      .orderBy(desc(interaction.occurredAt))
      .limit(50)
    const interactionIds = myInteractions.map((i) => i.id)
    const attendees =
      interactionIds.length > 0
        ? await db
            .select({
              interactionId: interactionEntity.interactionId,
              entityId: entity.id,
              name: entity.canonicalName,
              kind: entity.kind,
            })
            .from(interactionEntity)
            .innerJoin(entity, eq(entity.id, interactionEntity.entityId))
            .where(inArray(interactionEntity.interactionId, interactionIds))
        : []
    const attendeesBy = new Map<string, Array<{ id: string; name: string; kind: string }>>()
    for (const a of attendees) {
      if (a.entityId === data.entityId) continue
      attendeesBy.set(a.interactionId, [
        ...(attendeesBy.get(a.interactionId) ?? []),
        { id: a.entityId, name: a.name, kind: a.kind },
      ])
    }

    const items = [
      ...macros
        .filter(
          (m) =>
            !['company.updated', 'person.updated'].includes(m.verb) &&
            !m.verb.startsWith('interaction.'),
        )
        .map((m) => ({
          type: 'macro' as const,
          id: m.id,
          verb: m.verb,
          actorName: m.actorId ? (userNames.get(m.actorId) ?? null) : null,
          at: m.at.toISOString(),
        })),
      ...bursts.map((b, i) => ({
        type: 'attrs' as const,
        id: `burst-${i}`,
        actorName: b.actor ? (userNames.get(b.actor) ?? null) : null,
        at: b.at,
        changes: b.changes,
      })),
      ...myInteractions.map((i) => ({
        type: 'interaction' as const,
        id: i.id,
        kind: i.kind,
        subject: i.subject ?? '',
        at: i.occurredAt.toISOString(),
        attendees: attendeesBy.get(i.id) ?? [],
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1))

    return items.slice(0, 60)
  })

// ---------- dedupe inbox ----------

async function entityContext(id: string) {
  const [head] = await db
    .select({
      id: entity.id,
      name: entity.canonicalName,
      kind: entity.kind,
      source: entity.source,
      createdAt: entity.createdAt,
    })
    .from(entity)
    .where(eq(entity.id, id))
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
    createdAt: head.createdAt.toISOString(),
    domains: aliases.filter((a) => a.kind === 'domain').map((a) => a.valueNorm),
    otherNames: aliases
      .filter((a) => a.kind === 'name' && a.valueNorm !== head.name.toLowerCase())
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
      reason: r.reason as Record<string, string>,
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
    const [cand] = await db
      .select()
      .from(duplicateCandidate)
      .where(eq(duplicateCandidate.id, data.candidateId))
    if (!cand || cand.status !== 'open') throw new Error('Candidate not open')
    if (data.winnerId !== cand.entityA && data.winnerId !== cand.entityB)
      throw new Error('Winner must be one of the pair')
    const loserId =
      data.winnerId === cand.entityA ? cand.entityB : cand.entityA
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

// ---------- notes ----------

export const createNote = createServerFn({ method: 'POST' })
  .validator(
    z
      .object({
        /** Pre-link the note to an entity: starter block with its mention. */
        about: z
          .object({
            entityId: z.string().uuid(),
            label: z.string().max(200),
            kind: z.string().max(30),
          })
          .optional(),
        /** memo: the note IS the memo of `about` (tagged_in, not mentions). */
        noteKind: z.enum(['note', 'memo']).optional(),
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const about = data?.about
    const noteKind = data?.noteKind ?? 'note'
    return db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'note', canonicalName: 'Untitled', createdBy: u.id })
        .returning({ id: entity.id })

      const bodyJson = about
        ? [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'mention',
                  props: {
                    entityId: about.entityId,
                    label: about.label,
                    kind: about.kind,
                  },
                },
                { type: 'text', text: ' — ', styles: {} },
              ],
            },
          ]
        : null

      await tx.insert(note).values({
        entityId: ent.id,
        authorId: u.id,
        kind: noteKind,
        bodyJson: noteKind === 'memo' ? null : bodyJson,
        bodyMd:
          about && noteKind !== 'memo'
            ? `Mentions: [[${about.label}|entity:${about.entityId}]]\n`
            : '',
      })
      if (about) {
        if (about.kind === 'space') {
          // Written while standing in the space, so it is filed there, not
          // merely referenced — and it files through entity_space like every
          // other kind, inheriting its provenance/confidence story.
          await tx
            .insert(entitySpace)
            .values({
              entityId: ent.id,
              spaceId: about.entityId,
              source: 'manual',
              createdBy: u.id,
            })
            .onConflictDoNothing()
        } else {
          await tx.insert(link).values({
            fromEntityId: ent.id,
            toEntityId: about.entityId,
            relation: 'mentions',
            source: 'extracted',
            createdBy: u.id,
          })
        }
      }
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'note.created',
        subjectEntityId: about ? about.entityId : ent.id,
        objectEntityId: about ? ent.id : undefined,
      })
      return { id: ent.id }
    })
  })

export const listNotes = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: note.entityId,
      title: note.title,
      bodyMd: note.bodyMd,
      updatedAt: note.updatedAt,
      authorId: note.authorId,
    })
    .from(note)
    .innerJoin(entity, eq(entity.id, note.entityId))
    .where(isNull(entity.mergedIntoId))
    .orderBy(desc(note.updatedAt))
  return rows.map((r) => ({
    id: r.id,
    title: r.title || 'Untitled',
    snippet: r.bodyMd.replace(/\s+/g, ' ').slice(0, 140),
    updatedAt: r.updatedAt.toISOString(),
  }))
})

export const getNote = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [row] = await db
      .select({
        id: note.entityId,
        title: note.title,
        bodyJson: note.bodyJson,
        updatedAt: note.updatedAt,
      })
      .from(note)
      .where(eq(note.entityId, data.id))
    if (!row) throw new Error('Note not found')
    // jsonb comes back as unknown; it's a BlockNote document array.
    const bodyJson = row.bodyJson as Array<Json> | null

    // Backlinks: anything whose content mentions this note.
    const backlinks = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')),
      )
    // Spaces this note is filed in — the picker's current state.
    const spaces = await db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(entitySpace.entityId, data.id))
      .orderBy(asc(entity.canonicalName))

    return {
      id: row.id,
      title: row.title,
      bodyJson,
      updatedAt: row.updatedAt.toISOString(),
      backlinks,
      spaces,
    }
  })

const saveNoteInput = z.object({
  id: z.string().uuid(),
  title: z.string().max(300),
  /** Body fields absent = title-only save; body stays untouched. */
  body: z
    .object({
      bodyJson: z.unknown(),
      bodyMd: z.string().max(500_000),
      /** entity ids mentioned in the doc — extracted client-side from JSON */
      mentionIds: z.array(z.string().uuid()).max(500),
    })
    .optional(),
})

export const saveNote = createServerFn({ method: 'POST' })
  .validator(saveNoteInput)
  .handler(async ({ data }) => {
    const u = await requireUser()

    await db.transaction(async (tx) => {
      await tx
        .update(note)
        .set({
          title: data.title,
          updatedAt: new Date(),
          ...(data.body
            ? { bodyJson: data.body.bodyJson, bodyMd: data.body.bodyMd }
            : {}),
        })
        .where(eq(note.entityId, data.id))
      await tx
        .update(entity)
        .set({ canonicalName: data.title || 'Untitled' })
        .where(eq(entity.id, data.id))

      if (!data.body) return

      // Diff-sync mention links (only rows this sync owns: extracted).
      const existing = await tx
        .select({ id: link.id, toEntityId: link.toEntityId })
        .from(link)
        .where(
          and(
            eq(link.fromEntityId, data.id),
            eq(link.relation, 'mentions'),
            eq(link.source, 'extracted'),
          ),
        )
      const wanted = new Set(
        data.body.mentionIds.filter((m) => m !== data.id),
      )
      const current = new Set(existing.map((e) => e.toEntityId))
      for (const row of existing) {
        if (!wanted.has(row.toEntityId)) {
          await tx.delete(link).where(eq(link.id, row.id))
        }
      }
      for (const target of wanted) {
        if (!current.has(target)) {
          await tx
            .insert(link)
            .values({
              fromEntityId: data.id,
              toEntityId: target,
              relation: 'mentions',
              source: 'extracted',
              createdBy: u.id,
            })
            .onConflictDoNothing()
        }
      }
    })
    return { savedAt: new Date().toISOString() }
  })

/** Autocomplete over entities — mentions and reference pickers share it. */
export const searchEntities = createServerFn()
  .validator(
    z.object({
      q: z.string().max(120),
      kinds: z
        .array(
          z.enum([
            'company',
            'person',
            'organization',
            'deal',
            'space',
            'thesis',
            'note',
          ]),
        )
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const q = data.q.trim()
    if (!q) return []
    const pattern = `%${q}%`
    return db
      .selectDistinctOn([entity.id], {
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
      })
      .from(entity)
      .leftJoin(entityAlias, eq(entityAlias.entityId, entity.id))
      .where(
        and(
          isNull(entity.mergedIntoId),
          data.kinds
            ? inArray(entity.kind, data.kinds)
            : ne(entity.kind, 'document'),
          sql`(${entity.canonicalName} ilike ${pattern} or (${entityAlias.kind} = 'name' and ${entityAlias.valueNorm} ilike ${pattern}))`,
        ),
      )
      .limit(8)
  })

/**
 * Unified search — one box over names, note bodies, and extracted document
 * text, fused in Postgres rather than merged in Node.
 *
 * Everything searchable is an entity, so the three sources rank the *same*
 * id space and reciprocal rank fusion is the honest way to combine them:
 * scores from trigram similarity and ts_rank are not comparable, but ranks
 * are. RRF also generalises — when the pgvector half lands (CONTEXT.md →
 * Search is hybrid), it joins as a fourth CTE and nothing else changes.
 *
 * k = 60 is the standard RRF constant: large enough that a top hit in one
 * source doesn't automatically beat two decent hits across two sources.
 */
export const searchAll = createServerFn()
  .validator(z.object({ q: z.string().max(200) }))
  .handler(async ({ data }) => {
    await requireUser()
    const q = data.q.trim()
    if (q.length < 2) return []

    const rows = await db.execute<{
      id: string
      kind: string
      name: string
      snippet: string | null
      sources: Array<string>
      score: number
    }>(sql`
      with q as (
        select
          websearch_to_tsquery('english', ${q}) as tsq,
          ${q} as raw
      ),

      -- Names: trigram, so typos still land. Aliases count as names, which
      -- is how "Made In Space" finds a company stored under another label.
      name_hits as (
        select e.id,
               row_number() over (
                 order by greatest(
                   word_similarity((select raw from q), e.canonical_name),
                   coalesce(max(word_similarity((select raw from q), a.value_norm)), 0)
                 ) desc,
                 e.canonical_name
               ) as rnk
        from entity e
        left join entity_alias a
          on a.entity_id = e.id and a.kind = 'name'
        where e.merged_into_id is null
          and (
            e.canonical_name ilike '%' || (select raw from q) || '%'
            -- word_similarity, not similarity: the percent operator compares
            -- whole strings, so a short query against a long name always
            -- scores below threshold and "orbitl" would never reach "Orbital
            -- Composites". The word-similarity operator scores the query
            -- against the best-matching word instead.
            or (select raw from q) <% e.canonical_name
            or a.value_norm ilike '%' || (select raw from q) || '%'
            or (select raw from q) <% a.value_norm
          )
        group by e.id, e.canonical_name
        limit 40
      ),

      note_hits as (
        select n.entity_id as id,
               row_number() over (order by ts_rank(n.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', n.body_md, (select tsq from q),
                 'MaxWords=18, MinWords=6, ShortWord=3, MaxFragments=1, StartSel=«, StopSel=»'
               ) as snippet
        from note n
        join entity e on e.id = n.entity_id and e.merged_into_id is null
        where n.tsv @@ (select tsq from q)
        limit 40
      ),

      doc_hits as (
        select d.entity_id as id,
               row_number() over (order by ts_rank(d.tsv, (select tsq from q)) desc) as rnk,
               ts_headline('english', d.extracted_text, (select tsq from q),
                 'MaxWords=18, MinWords=6, ShortWord=3, MaxFragments=1, StartSel=«, StopSel=»'
               ) as snippet
        from document d
        join entity e on e.id = d.entity_id and e.merged_into_id is null
        where d.tsv @@ (select tsq from q)
        limit 40
      ),

      fused as (
        select id, 'name' as source, rnk, null::text as snippet from name_hits
        union all
        select id, 'note', rnk, snippet from note_hits
        union all
        select id, 'document', rnk, snippet from doc_hits
      )

      select f.id,
             e.kind,
             e.canonical_name as name,
             (array_remove(array_agg(f.snippet order by f.rnk), null))[1] as snippet,
             array_agg(distinct f.source) as sources,
             sum(1.0 / (60 + f.rnk)) as score
      from fused f
      join entity e on e.id = f.id
      group by f.id, e.kind, e.canonical_name
      order by score desc, e.canonical_name
      limit 20
    `)

    const hits = rows.rows
    if (hits.length === 0) return []

    // Documents have no page of their own — they are filed against a record,
    // so a result has to send you to that record or it is a dead end.
    const documentIds = hits.filter((h) => h.kind === 'document').map((h) => h.id)
    const parents =
      documentIds.length > 0
        ? await db
            .select({
              documentId: link.fromEntityId,
              parentId: entity.id,
              parentKind: entity.kind,
              parentName: entity.canonicalName,
            })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .where(
              and(
                inArray(link.fromEntityId, documentIds),
                eq(link.relation, 'tagged_in'),
              ),
            )
        : []

    return hits.map((h) => {
      const parent = parents.find((p) => p.documentId === h.id)
      return {
        id: h.id,
        kind: h.kind,
        name: h.name,
        snippet: h.snippet?.replace(/\s+/g, ' ').trim() ?? null,
        matchedIn: h.sources.includes('name')
          ? 'name'
          : (h.sources[0] ?? 'name'),
        parent: parent
          ? {
              id: parent.parentId,
              kind: parent.parentKind,
              name: parent.parentName,
            }
          : null,
      }
    })
  })

export const listUsers = createServerFn().handler(async () => {
  await requireUser()
  return db.select({ id: user.id, name: user.name }).from(user)
})

/**
 * Demo data, only ever by explicit request. Guarded on "no companies exist"
 * so it cannot land on top of real records.
 */
export const seedDemo = createServerFn({ method: 'POST' }).handler(async () => {
  const u = await requireUser()
  const { seedDemoData } = await import('./seeds/demo')
  return seedDemoData(u.id)
})

export const canSeedDemoData = createServerFn().handler(async () => {
  await requireUser()
  const { canSeedDemo } = await import('./seeds/demo')
  return { canSeed: await canSeedDemo() }
})

// ---------- glossary ----------

/**
 * Terms are scoped to a space because "stage" means something different in
 * aerospace and in bio — a global glossary would force one definition on
 * both. A null space_id is the deliberate exception: vocabulary true
 * everywhere (SAFE, pro-rata, ARR).
 */

const termInput = z.object({
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  definitionMd: z.string().trim().max(4000).default(''),
  spaceId: z.string().uuid().nullish(),
})

export const listTerms = createServerFn()
  .validator(z.object({ spaceId: z.string().uuid().nullish() }).optional())
  .handler(async ({ data }) => {
    await requireUser()
    const rows = await db
      .select({
        id: term.entityId,
        name: term.name,
        aliases: term.aliases,
        definitionMd: term.definitionMd,
        spaceId: term.spaceId,
        spaceName: entity.canonicalName,
      })
      .from(term)
      .leftJoin(space, eq(space.entityId, term.spaceId))
      .leftJoin(entity, eq(entity.id, space.entityId))
      .where(
        data?.spaceId
          ? // A space's glossary is its own terms, everything inherited from
            // its ancestors, and the global ones. Inheritance runs downward
            // only: PUE defined at Data centers is true in Cooling, but a
            // term defined in Cooling says nothing about Aerospace — which
            // is the collision the scoping exists to prevent.
            or(
              isNull(term.spaceId),
              sql`${term.spaceId} in (
                select anc.entity_id from space anc
                join space self on self.entity_id = ${data.spaceId}
                where anc.path @> self.path
              )`,
            )
          : undefined,
      )
      .orderBy(asc(term.name))
    return rows
  })

/**
 * The term set in scope for a note: everything from the spaces it is filed
 * in, plus global terms. Filing a note into Aerospace is what opts it into
 * the aerospace vocabulary — the same act that puts it on the space page.
 */
export const listTermsForNote = createServerFn()
  .validator(z.object({ noteId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const spaceIds = (
      await db
        .select({ spaceId: entitySpace.spaceId })
        .from(entitySpace)
        .where(eq(entitySpace.entityId, data.noteId))
    ).map((r) => r.spaceId)

    return db
      .select({
        id: term.entityId,
        name: term.name,
        aliases: term.aliases,
        definitionMd: term.definitionMd,
      })
      .from(term)
      .where(
        spaceIds.length > 0
          ? // Ancestors too: a note filed in Immersion cooling should know
            // the vocabulary of Cooling and of Data centers above it.
            or(
              isNull(term.spaceId),
              sql`${term.spaceId} in (
                select anc.entity_id from space anc
                join space self on self.entity_id = any(${sql.param(spaceIds)}::uuid[])
                where anc.path @> self.path
              )`,
            )
          : isNull(term.spaceId),
      )
      .orderBy(asc(term.name))
  })

export const createTerm = createServerFn({ method: 'POST' })
  .validator(termInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      const [ent] = await tx
        .insert(entity)
        .values({ kind: 'term', canonicalName: data.name, createdBy: u.id })
        .returning({ id: entity.id })
      await tx.insert(term).values({
        entityId: ent.id,
        name: data.name,
        aliases: data.aliases,
        definitionMd: data.definitionMd,
        spaceId: data.spaceId ?? null,
      })
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'term.created',
        subjectEntityId: ent.id,
      })
      return { id: ent.id }
    })
  })

export const updateTerm = createServerFn({ method: 'POST' })
  .validator(termInput.partial().extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.transaction(async (tx) => {
      await tx
        .update(term)
        .set({
          ...(data.name ? { name: data.name } : {}),
          ...(data.aliases ? { aliases: data.aliases } : {}),
          ...(data.definitionMd !== undefined
            ? { definitionMd: data.definitionMd }
            : {}),
          ...(data.spaceId !== undefined
            ? { spaceId: data.spaceId ?? null }
            : {}),
        })
        .where(eq(term.entityId, data.id))
      if (data.name) {
        await tx
          .update(entity)
          .set({ canonicalName: data.name })
          .where(eq(entity.id, data.id))
      }
    })
    return { ok: true }
  })

export const deleteTerm = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.transaction(async (tx) => {
      await tx
        .delete(link)
        .where(
          or(eq(link.fromEntityId, data.id), eq(link.toEntityId, data.id)),
        )
      await tx
        .delete(activity)
        .where(
          or(
            eq(activity.subjectEntityId, data.id),
            eq(activity.objectEntityId, data.id),
          ),
        )
      await tx.delete(term).where(eq(term.entityId, data.id))
      await tx.delete(entity).where(eq(entity.id, data.id))
    })
    return { ok: true }
  })

// ---------- theses ----------

/**
 * A thesis is a claim you hold, not a row. It deliberately has no attribute
 * registry — claim, conviction, status, and evidence on both sides is the
 * whole shape, and list-ifying it is the failure mode CONTEXT.md warns about.
 *
 * Evidence is open to any entity kind, not just companies. Disconfirmation is
 * usually an article or a teardown note rather than a company, and
 * evidence-against is the thing no generic CRM records.
 */

const CONVICTIONS = ['low', 'medium', 'high'] as const
const THESIS_STATUSES = ['forming', 'active', 'parked', 'killed'] as const

/** Terminal, and terminal means the reasoning gets captured. */
function isTerminal(status: (typeof THESIS_STATUSES)[number]) {
  return status === 'killed'
}

export const listTheses = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: thesis.entityId,
      name: entity.canonicalName,
      claim: thesis.claim,
      conviction: thesis.conviction,
      status: thesis.status,
      openedAt: thesis.openedAt,
      closedAt: thesis.closedAt,
      closedReason: thesis.closedReason,
      ownerId: thesis.ownerId,
    })
    .from(thesis)
    .innerJoin(entity, eq(entity.id, thesis.entityId))
    .where(isNull(entity.mergedIntoId))
    .orderBy(desc(thesis.openedAt))
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)

  // Spaces per thesis, one query.
  const spaceRows = await db
    .select({
      thesisId: thesisSpace.thesisEntityId,
      id: space.entityId,
      name: entity.canonicalName,
    })
    .from(thesisSpace)
    .innerJoin(space, eq(space.entityId, thesisSpace.spaceEntityId))
    .innerJoin(entity, eq(entity.id, space.entityId))
    .where(inArray(thesisSpace.thesisEntityId, ids))

  // Evidence tallies — the for/against split is the headline number.
  const evidence = await db
    .select({
      thesisId: link.toEntityId,
      relation: link.relation,
      n: count(),
    })
    .from(link)
    .where(
      and(
        inArray(link.toEntityId, ids),
        inArray(link.relation, ['evidence_for', 'evidence_against']),
      ),
    )
    .groupBy(link.toEntityId, link.relation)

  const spacesBy = new Map<string, Array<{ id: string; name: string }>>()
  for (const s of spaceRows) {
    spacesBy.set(s.thesisId, [
      ...(spacesBy.get(s.thesisId) ?? []),
      { id: s.id, name: s.name },
    ])
  }
  const tally = (id: string, relation: string) =>
    evidence.find((e) => e.thesisId === id && e.relation === relation)?.n ?? 0

  const users = await db.select({ id: user.id, name: user.name }).from(user)
  const names = new Map(users.map((u) => [u.id, u.name]))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    claim: r.claim,
    conviction: r.conviction,
    status: r.status,
    openedAt: r.openedAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    closedReason: r.closedReason,
    ownerName: r.ownerId ? (names.get(r.ownerId) ?? null) : null,
    spaces: spacesBy.get(r.id) ?? [],
    forCount: tally(r.id, 'evidence_for'),
    againstCount: tally(r.id, 'evidence_against'),
  }))
})

export const createThesis = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      claim: z.string().trim().min(1).max(2000),
      conviction: z.enum(CONVICTIONS).default('low'),
      spaceIds: z.array(z.string().uuid()).max(20).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    return db.transaction(async (tx) => {
      // canonical_name is the claim, truncated — it's what search, mentions,
      // and the command palette show. The full claim lives on the side table.
      const [ent] = await tx
        .insert(entity)
        .values({
          kind: 'thesis',
          canonicalName: data.claim.slice(0, 200),
          createdBy: u.id,
        })
        .returning({ id: entity.id })

      await tx.insert(thesis).values({
        entityId: ent.id,
        claim: data.claim,
        conviction: data.conviction,
        status: 'forming',
        // Someone holds the claim; everyone can see it.
        ownerId: u.id,
      })

      for (const spaceId of new Set(data.spaceIds ?? [])) {
        await tx
          .insert(thesisSpace)
          .values({ thesisEntityId: ent.id, spaceEntityId: spaceId })
          .onConflictDoNothing()
      }

      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'thesis.created',
        subjectEntityId: ent.id,
      })
      return { id: ent.id }
    })
  })

export const getThesis = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const [head] = await db
      .select({
        id: thesis.entityId,
        claim: thesis.claim,
        conviction: thesis.conviction,
        status: thesis.status,
        ownerId: thesis.ownerId,
        openedAt: thesis.openedAt,
        closedAt: thesis.closedAt,
        closedReason: thesis.closedReason,
        mergedIntoId: entity.mergedIntoId,
      })
      .from(thesis)
      .innerJoin(entity, eq(entity.id, thesis.entityId))
      .where(eq(thesis.entityId, data.id))
    if (!head) throw new Error('Thesis not found')

    const spaces = await db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(thesisSpace)
      .innerJoin(space, eq(space.entityId, thesisSpace.spaceEntityId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(thesisSpace.thesisEntityId, data.id))
      .orderBy(asc(entity.canonicalName))

    // Both sides in one query — they are the same shape and differ only in
    // which column of the page they land in.
    const evidenceRows = await db
      .select({
        linkId: link.id,
        relation: link.relation,
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        createdAt: link.createdAt,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, data.id),
          inArray(link.relation, ['evidence_for', 'evidence_against']),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(link.createdAt))

    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const names = new Map(users.map((u) => [u.id, u.name]))

    const shape = (r: (typeof evidenceRows)[number]) => ({
      linkId: r.linkId,
      id: r.id,
      name: r.name,
      kind: r.kind,
    })
    return {
      id: head.id,
      claim: head.claim,
      conviction: head.conviction,
      status: head.status,
      ownerName: head.ownerId ? (names.get(head.ownerId) ?? null) : null,
      openedAt: head.openedAt.toISOString(),
      closedAt: head.closedAt?.toISOString() ?? null,
      closedReason: head.closedReason,
      mergedIntoId: head.mergedIntoId,
      spaces,
      evidenceFor: evidenceRows
        .filter((r) => r.relation === 'evidence_for')
        .map(shape),
      evidenceAgainst: evidenceRows
        .filter((r) => r.relation === 'evidence_against')
        .map(shape),
    }
  })

/**
 * Status changes carry the reasoning. Killing a thesis without recording why
 * throws away the only thing a dead thesis is worth — reviving one is a
 * status change back, and the reason stays on the record either way.
 */
export const updateThesis = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      claim: z.string().trim().min(1).max(2000).optional(),
      conviction: z.enum(CONVICTIONS).optional(),
      status: z.enum(THESIS_STATUSES).optional(),
      closedReason: z.string().trim().max(2000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const [current] = await db
      .select({ status: thesis.status })
      .from(thesis)
      .where(eq(thesis.entityId, data.id))
    if (!current) throw new Error('Thesis not found')

    const nextStatus = data.status ?? current.status
    const nowTerminal = isTerminal(nextStatus)
    if (nowTerminal && !isTerminal(current.status) && !data.closedReason) {
      throw new Error('Killing a thesis needs a reason — that is the record')
    }

    await db.transaction(async (tx) => {
      await tx
        .update(thesis)
        .set({
          ...(data.claim ? { claim: data.claim } : {}),
          ...(data.conviction ? { conviction: data.conviction } : {}),
          ...(data.status ? { status: data.status } : {}),
          ...(nowTerminal
            ? {
                closedAt: isTerminal(current.status)
                  ? undefined
                  : new Date(),
                ...(data.closedReason
                  ? { closedReason: data.closedReason }
                  : {}),
              }
            : // Reopening clears the closure but never the claim's history —
              // activity keeps the trail.
              { closedAt: null, closedReason: null }),
        })
        .where(eq(thesis.entityId, data.id))

      if (data.claim) {
        await tx
          .update(entity)
          .set({ canonicalName: data.claim.slice(0, 200) })
          .where(eq(entity.id, data.id))
      }

      if (data.status && data.status !== current.status) {
        await tx.insert(activity).values({
          actorId: u.id,
          verb: `thesis.${data.status}`,
          subjectEntityId: data.id,
          meta: data.closedReason ? { reason: data.closedReason } : {},
        })
      }
    })
    return { ok: true }
  })

export const setThesisEvidence = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      thesisId: z.string().uuid(),
      entityId: z.string().uuid(),
      side: z.enum(['evidence_for', 'evidence_against']),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    if (data.thesisId === data.entityId) {
      throw new Error('A thesis cannot be its own evidence')
    }
    await db.transaction(async (tx) => {
      // One entity, one side. Moving a company from for to against is the
      // most informative edit there is — it must not leave both rows behind.
      const other =
        data.side === 'evidence_for' ? 'evidence_against' : 'evidence_for'
      await tx
        .delete(link)
        .where(
          and(
            eq(link.fromEntityId, data.entityId),
            eq(link.toEntityId, data.thesisId),
            eq(link.relation, other),
          ),
        )
      await tx
        .insert(link)
        .values({
          fromEntityId: data.entityId,
          toEntityId: data.thesisId,
          relation: data.side,
          source: 'manual',
          createdBy: u.id,
        })
        .onConflictDoNothing()
      await tx.insert(activity).values({
        actorId: u.id,
        verb: `thesis.${data.side}`,
        subjectEntityId: data.thesisId,
        objectEntityId: data.entityId,
      })
    })
    return { ok: true }
  })

export const removeThesisEvidence = createServerFn({ method: 'POST' })
  .validator(z.object({ linkId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    await db.delete(link).where(eq(link.id, data.linkId))
    return { ok: true }
  })

export const setThesisSpace = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      thesisId: z.string().uuid(),
      spaceId: z.string().uuid(),
      attached: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    if (data.attached) {
      await db
        .insert(thesisSpace)
        .values({
          thesisEntityId: data.thesisId,
          spaceEntityId: data.spaceId,
        })
        .onConflictDoNothing()
    } else {
      await db
        .delete(thesisSpace)
        .where(
          and(
            eq(thesisSpace.thesisEntityId, data.thesisId),
            eq(thesisSpace.spaceEntityId, data.spaceId),
          ),
        )
    }
    return { ok: true }
  })

// ---------- spaces (first real write path through the entity core) ----------

/** ltree labels: [a-z0-9_] only. */
function toLabel(name: string): string {
  const label = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return label || 'space'
}

export const listSpaces = createServerFn().handler(async () => {
  await requireUser()
  const rows = await db
    .select({
      id: space.entityId,
      name: entity.canonicalName,
      slug: space.slug,
      path: space.path,
      parentId: space.parentId,
      isSeeded: space.isSeeded,
    })
    .from(space)
    .innerJoin(entity, eq(entity.id, space.entityId))
    .orderBy(asc(space.path))
  return rows.map((r) => ({ ...r, depth: r.path.split('.').length - 1 }))
})

export const getSpace = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()

    const [head] = await db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        slug: space.slug,
        path: space.path,
        parentId: space.parentId,
        isSeeded: space.isSeeded,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(space.entityId, data.id))
    if (!head) throw new Error('Space not found')

    // Breadcrumb chain: every ancestor, resolved by path prefix.
    const labels = head.path.split('.')
    const ancestors =
      labels.length > 1
        ? await db
            .select({
              id: space.entityId,
              name: entity.canonicalName,
              path: space.path,
            })
            .from(space)
            .innerJoin(entity, eq(entity.id, space.entityId))
            .where(sql`${space.path} @> ${head.path} and ${space.path} != ${head.path}`)
            .orderBy(asc(space.path))
        : []

    const children = await db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(space.parentId, data.id))
      .orderBy(asc(entity.canonicalName))

    const companyRows = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        taggedVia: entitySpace.source,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .innerJoin(company, eq(company.entityId, entity.id))
      .where(
        and(eq(entitySpace.spaceId, data.id), isNull(entity.mergedIntoId)),
      )
      .orderBy(asc(entity.canonicalName))
    const companies = companyRows.map((c) => {
      const v = (c.values ?? {}) as Record<string, unknown>
      return {
        id: c.id,
        name: c.name,
        stage: (v.funding_stage as string) ?? null,
        geo: (v.location as string) ?? null,
        taggedVia: c.taggedVia,
      }
    })

    // Filed: notes the user deliberately put in this space. No singleton —
    // a space holds as many as its owner wants, and the "memo" is just the
    // first one filed.
    const filedRows = await db
      .select({
        id: note.entityId,
        title: note.title,
        bodyMd: note.bodyMd,
        kind: note.kind,
        updatedAt: note.updatedAt,
      })
      .from(entitySpace)
      .innerJoin(note, eq(note.entityId, entitySpace.entityId))
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(eq(entitySpace.spaceId, data.id), isNull(entity.mergedIntoId)),
      )
      .orderBy(desc(note.updatedAt))
    const filedIds = new Set(filedRows.map((f) => f.id))

    // Claims held about this space. They share the top block with filed
    // prose — what you think here is one idea, not two sections.
    const thesesRows = await db
      .select({
        id: thesis.entityId,
        claim: thesis.claim,
        conviction: thesis.conviction,
        status: thesis.status,
        closedReason: thesis.closedReason,
      })
      .from(thesisSpace)
      .innerJoin(thesis, eq(thesis.entityId, thesisSpace.thesisEntityId))
      .innerJoin(entity, eq(entity.id, thesis.entityId))
      .where(
        and(
          eq(thesisSpace.spaceEntityId, data.id),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(thesis.openedAt))

    const thesisIds = thesesRows.map((t) => t.id)
    const evidence =
      thesisIds.length > 0
        ? await db
            .select({
              thesisId: link.toEntityId,
              relation: link.relation,
              n: count(),
            })
            .from(link)
            .where(
              and(
                inArray(link.toEntityId, thesisIds),
                inArray(link.relation, ['evidence_for', 'evidence_against']),
              ),
            )
            .groupBy(link.toEntityId, link.relation)
        : []

    // Referenced: notes whose body happens to mention this space. A note
    // that is filed here too shows once, at the top — not in both lists.
    const notes = await db
      .select({
        id: note.entityId,
        title: note.title,
        updatedAt: note.updatedAt,
      })
      .from(link)
      .innerJoin(note, eq(note.entityId, link.fromEntityId))
      .where(and(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))
      .orderBy(desc(note.updatedAt))

    return {
      id: head.id,
      name: head.name,
      slug: head.slug,
      isSeeded: head.isSeeded,
      ancestors: ancestors.map((a) => ({ id: a.id, name: a.name })),
      children,
      companies,
      theses: thesesRows.map((t) => ({
        ...t,
        forCount:
          evidence.find(
            (e) => e.thesisId === t.id && e.relation === 'evidence_for',
          )?.n ?? 0,
        againstCount:
          evidence.find(
            (e) => e.thesisId === t.id && e.relation === 'evidence_against',
          )?.n ?? 0,
      })),
      filed: filedRows.map((f) => ({
        id: f.id,
        title: f.title,
        kind: f.kind,
        snippet: f.bodyMd
          .replace(/Mentions:.*$/s, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400),
        updatedAt: f.updatedAt.toISOString(),
      })),
      notes: notes
        .filter((n) => !filedIds.has(n.id))
        .map((n) => ({
          id: n.id,
          title: n.title || 'Untitled',
          updatedAt: n.updatedAt.toISOString(),
        })),
    }
  })

const createSpaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
})

export const createSpace = createServerFn({ method: 'POST' })
  .validator(createSpaceInput)
  .handler(async ({ data }) => {
    const u = await requireUser()

    return db.transaction(async (tx) => {
      let parentPath: string | null = null
      if (data.parentId) {
        const [parent] = await tx
          .select({ path: space.path })
          .from(space)
          .where(eq(space.entityId, data.parentId))
        if (!parent) throw new Error('Parent space not found')
        parentPath = parent.path
      }

      const base = toLabel(data.name)
      // Slugs are unique per parent — two branches may both hold a "Cooling".
      // Only a genuine same-parent collision gets the suffix.
      const siblingOf = data.parentId
        ? eq(space.parentId, data.parentId)
        : isNull(space.parentId)
      let slug = base
      for (let i = 2; ; i++) {
        const existing = await tx
          .select({ id: space.entityId })
          .from(space)
          .where(and(siblingOf, eq(space.slug, slug)))
        if (existing.length === 0) break
        slug = `${base}_${i}`
      }

      const [ent] = await tx
        .insert(entity)
        .values({
          kind: 'space',
          canonicalName: data.name,
          source: 'manual',
          createdBy: u.id,
        })
        .returning({ id: entity.id })

      await tx.insert(space).values({
        entityId: ent.id,
        parentId: data.parentId ?? null,
        slug,
        path: parentPath ? `${parentPath}.${slug}` : slug,
      })

      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'space.created',
        subjectEntityId: ent.id,
      })

      return { id: ent.id }
    })
  })
