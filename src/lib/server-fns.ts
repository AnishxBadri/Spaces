import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, count, desc, eq, isNull, ne, sql } from 'drizzle-orm'
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
        foundedYear: company.foundedYear,
        sectors: company.sectors,
        stage: company.stage,
        geo: company.geo,
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
      attrs: {
        foundedYear: head.foundedYear,
        sectors: head.sectors ?? [],
        stage: head.stage,
        geo: head.geo,
      },
      aliases,
      spaces,
      mentionedIn,
      timeline: timeline.map((t) => ({ ...t, at: t.at.toISOString() })),
    }
  })

const updateCompanyInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160).optional(),
  stage: z.string().trim().max(60).nullish(),
  geo: z.string().trim().max(120).nullish(),
  foundedYear: z.number().int().min(1800).max(2100).nullish(),
  sectors: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
})

export const updateCompany = createServerFn({ method: 'POST' })
  .validator(updateCompanyInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    await db.transaction(async (tx) => {
      if (data.name) {
        await tx
          .update(entity)
          .set({ canonicalName: data.name })
          .where(eq(entity.id, data.id))
      }
      await tx
        .update(company)
        .set({
          ...(data.stage !== undefined ? { stage: data.stage } : {}),
          ...(data.geo !== undefined ? { geo: data.geo } : {}),
          ...(data.foundedYear !== undefined
            ? { foundedYear: data.foundedYear }
            : {}),
          ...(data.sectors !== undefined ? { sectors: data.sectors } : {}),
        })
        .where(eq(company.entityId, data.id))
      await tx.insert(activity).values({
        actorId: u.id,
        verb: 'company.updated',
        subjectEntityId: data.id,
      })
    })
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
      })
      .optional(),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const about = data?.about
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
        bodyJson,
        bodyMd: about ? `Mentions: [[${about.label}|entity:${about.entityId}]]\n` : '',
      })
      if (about) {
        await tx.insert(link).values({
          fromEntityId: ent.id,
          toEntityId: about.entityId,
          relation: 'mentions',
          source: 'extracted',
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

/** Mention autocomplete — every linkable kind except documents. */
export const searchEntities = createServerFn()
  .validator(z.object({ q: z.string().max(120) }))
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
          ne(entity.kind, 'document'),
          sql`(${entity.canonicalName} ilike ${pattern} or (${entityAlias.kind} = 'name' and ${entityAlias.valueNorm} ilike ${pattern}))`,
        ),
      )
      .limit(8)
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
