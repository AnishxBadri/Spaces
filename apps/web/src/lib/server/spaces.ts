import { createServerFn } from '@tanstack/react-start'
import { Effect, Schema } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entitySpace,
  link,
  note,
  objectDef,
  space,
  term,
} from '@spaces/db/schema'
import { activity } from '@spaces/db/schema/activity'
import { jsonString } from '#/lib/json'
import { filedNotesProgram } from '#/lib/notes/filed'
import { createSpaceRow, requireUser } from './shared'

// Spaces — first real write path through the entity core. The reads are
// Effect programs (CONTEXT.md "Backend paradigm"): the handler checks the
// session, the program does the work, `Effect.runPromise` is the seam.

class SpaceNotFound extends Schema.TaggedError<SpaceNotFound>()(
  'SpaceNotFound',
  { id: Schema.String, message: Schema.String },
) {}

class SpaceQueryFailed extends Schema.TaggedError<SpaceQueryFailed>()(
  'SpaceQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new SpaceQueryFailed({ cause }),
  })

/** Live companies tagged into each space, one grouped query. */
const companyCountsBySpace = Effect.fn('companyCountsBySpace')(function* () {
  const rows = yield* query(() =>
    db
      .select({
        spaceId: entitySpace.spaceId,
        count: sql<number>`count(*)::int`,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .where(and(eq(entity.kind, 'company'), isNull(entity.mergedIntoId)))
      .groupBy(entitySpace.spaceId),
  )
  return new Map(rows.map((r) => [r.spaceId, r.count]))
})

/**
 * Notes filed into each space that this user may read — private notes file
 * like any other but only count for their author (canRead in SQL).
 */
const memoCountsBySpace = Effect.fn('memoCountsBySpace')(function* (
  userId: string,
) {
  const rows = yield* query(() =>
    db
      .select({
        spaceId: entitySpace.spaceId,
        count: sql<number>`count(*)::int`,
      })
      .from(entitySpace)
      .innerJoin(note, eq(note.entityId, entitySpace.entityId))
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          isNull(entity.mergedIntoId),
          or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
        ),
      )
      .groupBy(entitySpace.spaceId),
  )
  return new Map(rows.map((r) => [r.spaceId, r.count]))
})

/** Terms defined on each space (inherited ones count where defined). */
const termCountsBySpace = Effect.fn('termCountsBySpace')(function* () {
  const rows = yield* query(() =>
    db
      .select({ spaceId: term.spaceId, count: sql<number>`count(*)::int` })
      .from(term)
      .where(isNotNull(term.spaceId))
      .groupBy(term.spaceId),
  )
  return new Map(rows.map((r) => [r.spaceId, r.count]))
})

const listSpacesProgram = Effect.fn('listSpacesProgram')(function* (
  userId: string,
) {
  const rows = yield* query(() =>
    db
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
      .orderBy(asc(space.path)),
  )
  const [companies, memos, terms] = yield* Effect.all(
    [companyCountsBySpace(), memoCountsBySpace(userId), termCountsBySpace()],
    { concurrency: 'unbounded' },
  )
  return rows.map((r) => ({
    ...r,
    depth: r.path.split('.').length - 1,
    companies: companies.get(r.id) ?? 0,
    memos: memos.get(r.id) ?? 0,
    terms: terms.get(r.id) ?? 0,
  }))
})

export const listSpaces = createServerFn().handler(async () => {
  const u = await requireUser()
  return Effect.runPromise(listSpacesProgram(u.id))
})

/**
 * Exported for the test that pins the lanes' contents — in particular that
 * the `filed` lane carries a scratch note like any other (SPA-109). The
 * server fn below is the only production caller.
 */
export const getSpaceProgram = Effect.fn('getSpaceProgram')(function* (
  id: string,
  userId: string,
) {
  const head = (yield* query(() =>
    db
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
      .where(eq(space.entityId, id)),
  )).at(0)
  if (!head) {
    return yield* new SpaceNotFound({ id, message: 'Space not found' })
  }

  // Breadcrumb chain: every ancestor, resolved by path prefix.
  const ancestors =
    head.path.split('.').length > 1
      ? yield* query(() =>
          db
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
            .orderBy(asc(space.path)),
        )
      : []

  const childRows = yield* query(() =>
    db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(space.parentId, id))
      .orderBy(asc(entity.canonicalName)),
  )

  const companyRows = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        taggedVia: entitySpace.source,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .innerJoin(company, eq(company.entityId, entity.id))
      .where(and(eq(entitySpace.spaceId, id), isNull(entity.mergedIntoId)))
      .orderBy(asc(entity.canonicalName)),
  )

  // Tracking vs evaluating is a first-class distinction (CONTEXT.md "Space
  // membership is orthogonal to pipeline membership"): each company carries
  // how many live deals reference it, so the page can say which are in the
  // pipeline and which are only watched.
  const dealCounts =
    companyRows.length === 0
      ? new Map<string, number>()
      : new Map(
          (yield* query(() =>
            db
              .select({
                companyId: link.toEntityId,
                count: sql<number>`count(*)::int`,
              })
              .from(link)
              .innerJoin(entity, eq(entity.id, link.fromEntityId))
              .where(
                and(
                  inArray(
                    link.toEntityId,
                    companyRows.map((c) => c.id),
                  ),
                  eq(link.relation, 'references'),
                  eq(link.attrSlug, 'company'),
                  eq(entity.kind, 'deal'),
                  isNull(entity.mergedIntoId),
                ),
              )
              .groupBy(link.toEntityId),
          )).map((r) => [r.companyId, r.count]),
        )

  const companies = companyRows.map((c) => {
    const v = c.values
    return {
      id: c.id,
      name: c.name,
      stage: jsonString(v.funding_stage),
      geo: jsonString(v.location),
      taggedVia: c.taggedVia,
      deals: dealCounts.get(c.id) ?? 0,
    }
  })

  // Custom-object records tagged here (spec §9: customs live in the
  // research graph). Grouped by object on the page; each links through
  // its object's slug.
  const records = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        objectSlug: objectDef.slug,
        objectPlural: objectDef.plural,
        objectIcon: objectDef.icon,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .innerJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          eq(entitySpace.spaceId, id),
          eq(entity.kind, 'custom'),
          isNull(entity.mergedIntoId),
          eq(objectDef.archived, false),
        ),
      )
      .orderBy(asc(objectDef.plural), asc(entity.canonicalName)),
  )

  // Filed: notes the user deliberately put in this space. No singleton —
  // a space holds as many as its owner wants, and which one leads is the
  // ordering's answer, not the schema's (see `lib/notes/filed`).
  const filed = yield* filedNotesProgram(userId, id)
  const filedIds = new Set(filed.map((f) => f.id))

  // Referenced: notes whose body happens to mention this space. A note
  // that is filed here too shows once, at the top — not in both lists.
  const mentions = yield* query(() =>
    db
      .select({
        id: note.entityId,
        title: note.title,
        updatedAt: note.updatedAt,
      })
      .from(link)
      .innerJoin(note, eq(note.entityId, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, id),
          eq(link.relation, 'mentions'),
          or(eq(note.visibility, 'shared'), eq(note.authorId, userId)),
        ),
      )
      .orderBy(desc(note.updatedAt)),
  )

  // The map around this node: each subspace with what it holds, so the
  // rail reads as a market map and not a list of names.
  const [companyCounts, memoCounts] = yield* Effect.all(
    [companyCountsBySpace(), memoCountsBySpace(userId)],
    { concurrency: 'unbounded' },
  )

  return {
    id: head.id,
    name: head.name,
    slug: head.slug,
    isSeeded: head.isSeeded,
    ancestors: ancestors.map((a) => ({ id: a.id, name: a.name })),
    parent: ancestors.at(-1) ?? null,
    children: childRows.map((c) => ({
      ...c,
      companies: companyCounts.get(c.id) ?? 0,
      memos: memoCounts.get(c.id) ?? 0,
    })),
    companies,
    records,
    filed,
    notes: mentions
      .filter((n) => !filedIds.has(n.id))
      .map((n) => ({
        id: n.id,
        title: n.title || 'Untitled',
        updatedAt: n.updatedAt.toISOString(),
      })),
  }
})

export const getSpace = createServerFn()
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const u = await requireUser()
    return Effect.runPromise(getSpaceProgram(data.id, u.id))
  })

const createSpaceInput = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
})

export const createSpace = createServerFn({ method: 'POST' })
  .validator(createSpaceInput)
  .handler(async ({ data }) => {
    const u = await requireUser()
    const id = await createSpaceRow(data.name, data.parentId ?? null, u.id)
    await db.insert(activity).values({
      actorId: u.id,
      verb: 'space.created',
      subjectEntityId: id,
    })
    return { id }
  })
