import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from './auth'
import { db } from '#/db'
import { user } from '#/db/schema/auth'
import { entity, entityAlias, space } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { resolveEntity } from './entities/resolve'
import { storeCredential } from './vault'

/**
 * Server functions consumed by route loaders and forms. Auth checks happen
 * here — never trust the client to have done them.
 */

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
