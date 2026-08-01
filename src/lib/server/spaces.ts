import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { company, entity, entitySpace, link, note, space } from '#/db/schema'
import { activity } from '#/db/schema/activity'
import { requireUser } from './shared'

// Spaces — first real write path through the entity core.

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
            .where(
              sql`${space.path} @> ${head.path} and ${space.path} != ${head.path}`,
            )
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
      .where(and(eq(entitySpace.spaceId, data.id), isNull(entity.mergedIntoId)))
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
      .where(and(eq(entitySpace.spaceId, data.id), isNull(entity.mergedIntoId)))
      .orderBy(desc(note.updatedAt))
    const filedIds = new Set(filedRows.map((f) => f.id))

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
