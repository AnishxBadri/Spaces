import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import { asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#/db'
import { attribute, objectDef } from '#/db/schema'
import { requireUser } from './shared'

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

const listObjectsProgram = Effect.fn('listObjectsProgram')(function* () {
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
      .where(eq(objectDef.archived, false))
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

export const listObjects = createServerFn().handler(async () => {
  await requireUser()
  return Effect.runPromise(listObjectsProgram())
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
