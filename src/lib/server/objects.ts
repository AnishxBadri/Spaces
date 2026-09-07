import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { attribute, entity, link, objectDef } from '#/db/schema'
import { user } from '#/db/schema/auth'
import { requireUser } from './shared'
import type { Json } from './shared'

/**
 * The object registry, read side (CONTEXT.md "Two-tier object model"). One
 * list serves the settings index and, later, the sidebar for custom objects:
 * system rows first (seed order), then user objects by creation.
 */

class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()(
  'ObjectNotFound',
  { slug: Schema.String, message: Schema.String },
) {}

class ObjectQueryFailed extends Schema.TaggedError<ObjectQueryFailed>()(
  'ObjectQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ObjectQueryFailed({ cause }),
  })

const listObjectsProgram = Effect.fn('listObjectsProgram')(function* (
  includeArchived: boolean,
) {
  const rows = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        icon: objectDef.icon,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
      })
      .from(objectDef)
      .where(includeArchived ? undefined : eq(objectDef.archived, false))
      .orderBy(asc(objectDef.createdAt)),
  )
  // Live attributes only — archived ones sit in the page's own collapsed
  // section and shouldn't inflate the index count.
  const counts = yield* query(() =>
    db
      .select({
        objectId: attribute.objectId,
        count: sql<number>`count(*)::int`,
      })
      .from(attribute)
      .where(eq(attribute.archived, false))
      .groupBy(attribute.objectId),
  )
  const countBy = new Map(counts.map((c) => [c.objectId, c.count]))
  // System rows first regardless of creation order.
  return rows
    .map((r) => ({ ...r, attributeCount: countBy.get(r.id) ?? 0 }))
    .sort((a, b) => Number(b.isSystem) - Number(a.isSystem))
})

export const listObjects = createServerFn()
  .validator(z.object({ includeArchived: z.boolean().optional() }).optional())
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(listObjectsProgram(data?.includeArchived ?? false))
  })

const getObjectProgram = Effect.fn('getObjectProgram')(function* (
  slug: string,
): Effect.fn.Return<
  {
    id: string
    slug: string
    singular: string
    plural: string
    icon: string | null
    isSystem: boolean
    archived: boolean
  },
  ObjectNotFound | ObjectQueryFailed
> {
  const row = yield* query(() =>
    db
      .select({
        id: objectDef.id,
        slug: objectDef.slug,
        singular: objectDef.singular,
        plural: objectDef.plural,
        icon: objectDef.icon,
        isSystem: objectDef.isSystem,
        archived: objectDef.archived,
      })
      .from(objectDef)
      .where(eq(objectDef.slug, slug))
      .then((rows) => rows.at(0)),
  )
  if (!row)
    return yield* new ObjectNotFound({ slug, message: 'Object not found' })
  return row
})

export const getObject = createServerFn()
  .validator(z.object({ slug: z.string().min(1).max(80) }))
  .handler(async ({ data }) => {
    await requireUser()
    return Effect.runPromise(getObjectProgram(data.slug))
  })

// ---------------------------------------------------------------------------
// Custom objects: creation, lifecycle, and their records (spec §9).
// ---------------------------------------------------------------------------

export const createObject = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      singular: z.string().trim().min(1).max(60),
      plural: z.string().trim().min(1).max(60),
      icon: z.string().max(40).optional(),
    }),
  )
  .handler(async ({ data }) => {
    // Reshaping the workspace's vocabulary — admin, like attribute edits.
    const { requireAdmin } = await import('./shared')
    const u = await requireAdmin()
    const { createObjectProgram } =
      await import('../attributes/object-registry')
    const { effectFn } = await import('./effect')
    return effectFn(createObjectProgram)({ ...data, createdBy: u.id })
  })

export const updateObject = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: z.string().uuid(),
      singular: z.string().trim().min(1).max(60).optional(),
      plural: z.string().trim().min(1).max(60).optional(),
      icon: z.string().max(40).nullable().optional(),
      archived: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { requireAdmin } = await import('./shared')
    await requireAdmin()
    const { updateObjectProgram } =
      await import('../attributes/object-registry')
    const { effectFn } = await import('./effect')
    return effectFn(updateObjectProgram)(data)
  })

/** The registry-generated list page's rows: name, values, spaces, added. */
export const listObjectRecords = createServerFn()
  .validator(z.object({ objectId: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { entitySpace } = await import('#/db/schema')
    const { desc, isNull, and: andOp } = await import('drizzle-orm')
    const rows = await db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        createdAt: entity.createdAt,
      })
      .from(entity)
      .where(
        andOp(
          eq(entity.objectId, data.objectId),
          eq(entity.kind, 'custom'),
          isNull(entity.mergedIntoId),
        ),
      )
      .orderBy(desc(entity.createdAt))
    const ids = rows.map((r) => r.id)
    const tags =
      ids.length > 0
        ? await db
            .select({
              entityId: entitySpace.entityId,
              spaceId: entitySpace.spaceId,
              spaceName: entity.canonicalName,
            })
            .from(entitySpace)
            .innerJoin(entity, eq(entity.id, entitySpace.spaceId))
            .where(inArray(entitySpace.entityId, ids))
        : []
    const spacesBy = new Map<string, Array<{ id: string; name: string }>>()
    for (const t of tags)
      spacesBy.set(t.entityId, [
        ...(spacesBy.get(t.entityId) ?? []),
        { id: t.spaceId, name: t.spaceName },
      ])
    // Names for record-reference values, so cells can render them.
    const refs =
      ids.length > 0
        ? await db
            .select({ toId: link.toEntityId, name: entity.canonicalName })
            .from(link)
            .innerJoin(entity, eq(entity.id, link.toEntityId))
            .where(
              andOp(
                eq(link.relation, 'references'),
                inArray(link.fromEntityId, ids),
              ),
            )
        : []
    const users = await db.select({ id: user.id, name: user.name }).from(user)
    return {
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        values: (r.values ?? {}) as Record<string, Json>,
        spaces: spacesBy.get(r.id) ?? [],
        createdAt: r.createdAt.toISOString(),
      })),
      refNames: {
        ...Object.fromEntries(refs.map((r) => [r.toId, { name: r.name }])),
        ...Object.fromEntries(users.map((u) => [u.id, { name: u.name }])),
      },
    }
  })

/** The registry-generated record page's data. */
export const getObjectRecord = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { entitySpace, space } = await import('#/db/schema')
    const { and: andOp, isNull } = await import('drizzle-orm')
    const head = (
      await db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          kind: entity.kind,
          objectId: entity.objectId,
          mergedIntoId: entity.mergedIntoId,
          createdAt: entity.createdAt,
          createdBy: entity.createdBy,
          values: entity.values,
          objectSlug: objectDef.slug,
          objectSingular: objectDef.singular,
          objectPlural: objectDef.plural,
          objectIcon: objectDef.icon,
          objectArchived: objectDef.archived,
        })
        .from(entity)
        .innerJoin(objectDef, eq(objectDef.id, entity.objectId))
        .where(andOp(eq(entity.id, data.id), eq(entity.kind, 'custom')))
    ).at(0)
    if (!head) throw new Error('Record not found')

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

    // Outgoing references (this record's reference attributes) → names.
    const outRefs = await db
      .select({
        toId: link.toEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.toEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        andOp(eq(link.fromEntityId, data.id), eq(link.relation, 'references')),
      )
    // Incoming references — backlinks both ways (§9): who points at this.
    const referencedBy = await db
      .select({
        fromId: link.fromEntityId,
        attrSlug: link.attrSlug,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
        objectSingular: objectDef.singular,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        andOp(
          eq(link.toEntityId, data.id),
          eq(link.relation, 'references'),
          isNull(entity.mergedIntoId),
        ),
      )
    const mentionedIn = await db
      .select({
        fromId: link.fromEntityId,
        name: entity.canonicalName,
        kind: entity.kind,
        objectSlug: objectDef.slug,
      })
      .from(link)
      .innerJoin(entity, eq(entity.id, link.fromEntityId))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(andOp(eq(link.toEntityId, data.id), eq(link.relation, 'mentions')))

    const users = await db.select({ id: user.id, name: user.name }).from(user)
    const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]))

    return {
      id: head.id,
      name: head.name,
      mergedIntoId: head.mergedIntoId,
      createdAt: head.createdAt.toISOString(),
      createdByName: head.createdBy
        ? (userNames[head.createdBy] ?? null)
        : null,
      values: (head.values ?? {}) as Record<string, Json>,
      object: {
        id: head.objectId!,
        slug: head.objectSlug,
        singular: head.objectSingular,
        plural: head.objectPlural,
        icon: head.objectIcon,
        archived: head.objectArchived,
      },
      spaces,
      referencedBy,
      mentionedIn,
      refNames: {
        ...Object.fromEntries(
          outRefs.map((r) => [
            r.toId,
            { name: r.name, kind: r.kind, objectSlug: r.objectSlug },
          ]),
        ),
        ...Object.fromEntries(users.map((u) => [u.id, { name: u.name }])),
      },
      userNames,
    }
  })

export const createObjectRecord = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      objectId: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      values: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { createRecordProgram } =
      await import('../attributes/object-registry')
    const { effectFn } = await import('./effect')
    return effectFn(createRecordProgram)({
      objectId: data.objectId,
      name: data.name,
      values: data.values,
      actor: { type: 'user', id: u.id },
    })
  })
