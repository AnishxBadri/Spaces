import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from './auth'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
import {
  company,
  duplicateCandidate,
  entity,
  entityAlias,
  entitySpace,
  link,
  note,
  person,
  space,
} from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { addIdentityAlias, resolveEntity } from './entities/resolve'
import { mergeEntities } from './entities/merge'
import { storeCredential } from './vault'

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
  .validator(z.object({ kind: z.enum(['company', 'person', 'deal']) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { getRegistry } = await import('./attributes/values')
    const defs = await getRegistry(data.kind)
    return defs.map((d) => ({
      id: d.id,
      slug: d.slug,
      name: d.name,
      type: d.type,
      options: d.options as Json,
      isSystem: d.isSystem,
      sortOrder: d.sortOrder,
    }))
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

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    values: (r.values ?? {}) as Record<string, Json>,
    domains: domainsBy.get(r.id) ?? [],
    spaces: spacesBy.get(r.id) ?? [],
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

    const items = [
      ...macros
        .filter((m) => !['company.updated', 'person.updated'].includes(m.verb))
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
        await tx.insert(link).values({
          fromEntityId: ent.id,
          toEntityId: about.entityId,
          // A memo belongs to its space; a note merely mentions things.
          relation: noteKind === 'memo' ? 'tagged_in' : 'mentions',
          source: noteKind === 'memo' ? 'manual' : 'extracted',
          createdBy: u.id,
        })
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
    return {
      id: row.id,
      title: row.title,
      bodyJson,
      updatedAt: row.updatedAt.toISOString(),
      backlinks,
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

export const listUsers = createServerFn().handler(async () => {
  await requireUser()
  return db.select({ id: user.id, name: user.name }).from(user)
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

    // The memo: a note of kind memo linked tagged_in to this space.
    const [memo] = await db
      .select({
        id: note.entityId,
        title: note.title,
        bodyMd: note.bodyMd,
        updatedAt: note.updatedAt,
      })
      .from(link)
      .innerJoin(note, eq(note.entityId, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, data.id),
          eq(link.relation, 'tagged_in'),
          eq(note.kind, 'memo'),
        ),
      )
      .orderBy(desc(note.updatedAt))
      .limit(1)

    // Research: notes that mention this space.
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
      memo: memo
        ? {
            id: memo.id,
            title: memo.title,
            snippet: memo.bodyMd
              .replace(/Mentions:.*$/s, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 280),
            updatedAt: memo.updatedAt.toISOString(),
          }
        : null,
      notes: notes.map((n) => ({
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
      // Slugs are globally unique; suffix on collision.
      let slug = base
      for (let i = 2; ; i++) {
        const existing = await tx
          .select({ id: space.entityId })
          .from(space)
          .where(eq(space.slug, slug))
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
