import { Clock, Effect, Schema } from 'effect'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@spaces/db'
import {
  attribute,
  company,
  entity,
  entitySpace,
  link,
  note,
  objectDef,
  space,
  term,
} from '@spaces/db/schema'
import {
  spaceInheritedSourcesProgram,
  spaceSourcesProgram,
} from '#/lib/documents/space-sources'
import { jsonString } from '@spaces/core/json'
import { archiveCountsProgram } from '@spaces/core/writes/entities/space'
import { filedNotesProgram } from '#/lib/notes/filed'
import { localDay } from '#/lib/records/readout-format'
import { liveSpaceSql } from '#/lib/spaces/live'
import {
  spaceContactsProgram,
  spaceInheritedContactsProgram,
} from '#/lib/people/space-contacts'

// Space reads as Effect programs, outside the server-fn module on purpose:
// that barrel is client-imported and only `createServerFn().handler()` bodies
// are stripped, so a plain export there ships — and this reaches `db`, which
// drags `pg` into the client and kills hydration. The spaces server fns are
// the only production callers.

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
      .where(
        and(
          eq(entity.kind, 'company'),
          isNull(entity.mergedIntoId),
          isNull(entity.archivedAt),
        ),
      )
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

/** The tree and the space picker: live spaces only, in path order. */
export const listSpacesProgram = Effect.fn('listSpacesProgram')(function* (
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
      .where(liveSpaceSql)
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

/**
 * The newest filing into each live space or any live space under it — the
 * index's `last filed` lane. One grouped query over the ltree containment.
 */
const lastFiledBySpace = Effect.fn('lastFiledBySpace')(function* () {
  const below = alias(space, 'below')
  const rows = yield* query(() =>
    db
      .select({ spaceId: space.entityId, at: max(entitySpace.createdAt) })
      .from(space)
      .innerJoin(below, sql`${below.path} <@ ${space.path}`)
      .innerJoin(entitySpace, eq(entitySpace.spaceId, below.entityId))
      .where(isNull(below.archivedAt))
      .groupBy(space.entityId),
  )
  return new Map(rows.map((r) => [r.spaceId, r.at]))
})

/**
 * The archive heads: archived spaces with no archived ancestor, newest first.
 * Restore on a head brings back every space archived with it.
 */
const archivedHeads = Effect.fn('archivedHeads')(function* () {
  const rows = yield* query(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        archivedAt: space.archivedAt,
        within: sql<string | null>`(
          select string_agg(up_entity.canonical_name, ' / ' order by nlevel(up.path))
          from space up join entity up_entity on up_entity.id = up.entity_id
          where up.path @> ${space.path} and up.path <> ${space.path}
        )`,
        spaces: sql<number>`(
          select count(*)::int from space held
          where held.path <@ ${space.path} and held.archived_at = ${space.archivedAt}
        )`,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        and(
          isNotNull(space.archivedAt),
          sql`not exists (
            select 1 from space arch
            where arch.path @> ${space.path} and arch.path <> ${space.path}
              and arch.archived_at is not null
          )`,
        ),
      )
      .orderBy(desc(space.archivedAt)),
  )
  return rows.flatMap((r) =>
    r.archivedAt === null
      ? []
      : [
          {
            id: r.id,
            name: r.name,
            within: r.within,
            spaces: r.spaces,
            archivedOn: localDay(r.archivedAt),
          },
        ],
  )
})

/**
 * The spaces index: the live tree with each row's last filed day, the
 * archive heads for the fold, and the server's `today` the days print from.
 */
export const spacesIndexProgram = Effect.fn('spacesIndexProgram')(function* (
  userId: string,
) {
  const [rows, lastFiled, archived] = yield* Effect.all(
    [listSpacesProgram(userId), lastFiledBySpace(), archivedHeads()],
    { concurrency: 'unbounded' },
  )
  const now = yield* Clock.currentTimeMillis
  return {
    today: localDay(new Date(now)),
    spaces: rows.map((r) => {
      const at = lastFiled.get(r.id) ?? null
      return { ...r, lastFiled: at === null ? null : localDay(at) }
    }),
    archived,
  }
})

/**
 * Exported for the test that pins the lanes' contents (the `filed` lane
 * carries a scratch note like any other). The server fn is the only
 * production caller.
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
        archivedAt: space.archivedAt,
        criteria: space.criteria,
        createdAt: entity.createdAt,
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
              archived: sql<boolean>`${space.archivedAt} is not null`,
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
      .where(and(eq(space.parentId, id), isNull(space.archivedAt)))
      .orderBy(asc(entity.canonicalName)),
  )

  const companyRows = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        taggedVia: entitySpace.source,
        filedAt: entitySpace.createdAt,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .innerJoin(company, eq(company.entityId, entity.id))
      .where(
        and(
          eq(entitySpace.spaceId, id),
          isNull(entity.mergedIntoId),
          isNull(entity.archivedAt),
        ),
      )
      .orderBy(asc(entity.canonicalName)),
  )

  // Space membership is orthogonal to pipeline membership: each company
  // carries how many live deals reference it, so the page can say which are
  // in the pipeline and which are only watched.
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
                  isNull(entity.archivedAt),
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
      filedAt: c.filedAt.toISOString(),
      deals: dealCounts.get(c.id) ?? 0,
    }
  })

  // The stage bar and the default sort follow the company `funding_stage`
  // options as the registry orders them, so a renamed or added stage
  // reorders the page with no code change.
  const stageOptions =
    (yield* query(() =>
      db
        .select({ options: attribute.options })
        .from(attribute)
        .innerJoin(objectDef, eq(objectDef.id, attribute.objectId))
        .where(
          and(
            eq(objectDef.slug, 'companies'),
            eq(objectDef.isSystem, true),
            eq(attribute.slug, 'funding_stage'),
          ),
        ),
    )).at(0)?.options.options ?? []

  // Last filed: the newest filing of any kind into this space.
  const lastFiledRow = (yield* query(() =>
    db
      .select({ at: max(entitySpace.createdAt) })
      .from(entitySpace)
      .where(eq(entitySpace.spaceId, id)),
  )).at(0)
  const now = yield* Clock.currentTimeMillis
  const lastFiled = lastFiledRow?.at
    ? {
        on: lastFiledRow.at.toISOString(),
        days: Math.max(
          0,
          Math.floor((now - lastFiledRow.at.getTime()) / 86_400_000),
        ),
      }
    : null

  // Custom-object records tagged here, grouped by object on the page; each
  // links through its object's slug.
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
          isNull(entity.archivedAt),
          eq(objectDef.archived, false),
        ),
      )
      .orderBy(asc(objectDef.plural), asc(entity.canonicalName)),
  )

  // Filed: notes the user deliberately put in this space. No singleton —
  // a space holds as many as its owner wants, and which one leads is the
  // ordering's answer, not the schema's.
  const filed = yield* filedNotesProgram(userId, id)
  const filedIds = new Set(filed.map((f) => f.id))

  // Sources: documents filed here, through `entity_space` rather than
  // `link(tagged_in)`, so the query is its own.
  // The inherited lane (documents on the companies tagged here) is a
  // separate field on purpose: the headline count is what was filed here,
  // and inheritance is a convenience, not a claim of filing.
  const [sources, inheritedSources] = yield* Effect.all(
    [spaceSourcesProgram(id, userId), spaceInheritedSourcesProgram(id, userId)],
    { concurrency: 'unbounded' },
  )

  // Contacts: the same two lanes for the same reasons. `contacts` is who was
  // tagged here and is the only thing counted; `inheritedContacts` is who
  // the companies here bring with them.
  const [contacts, inheritedContacts] = yield* Effect.all(
    [spaceContactsProgram(id), spaceInheritedContactsProgram(id)],
    { concurrency: 'unbounded' },
  )

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

  // Archived: what still holds, for the notice under the head. An ancestor
  // archived over it is named instead, since Restore belongs to that space.
  const archivedUnder = ancestors.filter((a) => a.archived).at(-1) ?? null
  const archive = head.archivedAt
    ? {
        on: head.archivedAt.toISOString(),
        ...(yield* archiveCountsProgram(head.id, head.path).pipe(
          Effect.mapError((e) => new SpaceQueryFailed({ cause: e })),
        )),
      }
    : null

  return {
    id: head.id,
    name: head.name,
    slug: head.slug,
    path: head.path,
    parentId: head.parentId,
    isSeeded: head.isSeeded,
    criteria: head.criteria,
    createdAt: head.createdAt.toISOString(),
    lastFiled,
    stageOptions: stageOptions.map((o) => ({ id: o.id, label: o.label })),
    archive,
    archivedUnder: archivedUnder
      ? { id: archivedUnder.id, name: archivedUnder.name }
      : null,
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
    sources,
    inheritedSources,
    contacts,
    inheritedContacts,
    notes: mentions
      .filter((n) => !filedIds.has(n.id))
      .map((n) => ({
        id: n.id,
        title: n.title || 'Untitled',
        updatedAt: n.updatedAt.toISOString(),
      })),
  }
})
