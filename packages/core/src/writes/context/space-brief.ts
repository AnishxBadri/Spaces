import { Effect, Schema } from 'effect'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  entity,
  entityAlias,
  entitySpace,
  note,
  space,
  term,
} from '@spaces/db/schema'
import type {
  JsonObject,
  JsonValue,
  Ref,
  SpaceBrief,
  SpaceBriefMember,
  SpaceBriefMemo,
  SpaceBriefNode,
  SpaceBriefTerm,
} from '@spaces/sdk'
import { ContextLeak, ContextQueryFailed } from '../../context/errors'
import { truncate } from '../../context/render'
import { canRead } from '../../read-policy'
import { sensitivityFor } from '../ai/sensitivity-for'
import { memosTaggedIn, query, readableNote } from './spaces'

/**
 * A space as the subject (D71): the brief a watch's engine turns into its own
 * query (D72). Data, never prompt text — each piece is a field, not a line.
 * - Read as `reader` (`canRead`): an integration sees shared notes only.
 * - Refused, never partial: a space that is missing, archived (itself or an
 *   ancestor) or sensitive anywhere in its path answers `SpaceBriefRefused`.
 * - Inside the subtree, a sensitive or archived subspace leaves with its
 *   whole branch, and a member sensitive by any input is left out.
 * - `spaceSubjectProgram` reads the same brief for Ask, where sensitivity
 *   marks the call instead of cutting the brief (`SpaceBriefMode`).
 */

export class SpaceBriefRefused extends Schema.TaggedError<SpaceBriefRefused>()(
  'SpaceBriefRefused',
  { spaceId: Schema.String, reason: Schema.String },
) {}

/** The key values a member carries — what an engine seeds from. */
export const BRIEF_KEY_SLUGS = [
  'description',
  'business_model',
  'funding_stage',
  'location',
  'founded_year',
] as const

/** Members handed over; `memberCount` says how many there are in all. */
export const BRIEF_MEMBERS_MAX = 100
const MEMO_MAX = 2000
const TERM_MAX = 600

/**
 * How the brief is read.
 * - `watch`: it leaves the box. A sensitive or archived subject refuses; a
 *   sensitive subspace or member is left out.
 * - `context`: Ask's space subject (D71). Nothing sensitive is cut; the call
 *   is marked sensitive instead, and only archived subspaces leave.
 */
export type SpaceBriefMode = 'watch' | 'context'

/** A brief, and whether anything in it — path, subtree, member — is sensitive. */
export type SpaceSubject = {
  brief: SpaceBrief
  sensitive: boolean
  /** Every space in the kept subtree and every member, for the egress gate. */
  reveals: ReadonlyArray<string>
}

export const spaceBriefProgram = Effect.fn('spaceBriefProgram')(function* (
  spaceId: string,
  reader: { readonly id: string },
): Effect.fn.Return<
  SpaceBrief,
  SpaceBriefRefused | ContextQueryFailed | ContextLeak
> {
  return (yield* readBrief(spaceId, reader, 'watch')).brief
})

/** A space as Ask's subject: the brief with nothing sensitive cut. (D71) */
export const spaceSubjectProgram = Effect.fn('spaceSubjectProgram')(function* (
  spaceId: string,
  reader: { readonly id: string },
): Effect.fn.Return<
  SpaceSubject,
  SpaceBriefRefused | ContextQueryFailed | ContextLeak
> {
  return yield* readBrief(spaceId, reader, 'context')
})

const readBrief = Effect.fn('readBrief')(function* (
  spaceId: string,
  reader: { readonly id: string },
  mode: SpaceBriefMode,
): Effect.fn.Return<
  SpaceSubject,
  SpaceBriefRefused | ContextQueryFailed | ContextLeak
> {
  const refuse = (reason: string) => new SpaceBriefRefused({ spaceId, reason })
  const watch = mode === 'watch'

  // ---------- the subject and its path ----------
  const head = (yield* query(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        path: space.path,
        criteria: space.criteria,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(space.entityId, spaceId)),
  )).at(0)
  if (!head) return yield* refuse(`no space ${spaceId}`)

  const path = yield* query(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        archived: sql<boolean>`${space.archivedAt} is not null`,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(sql`${space.path} @> ${head.path}`)
      .orderBy(asc(sql`nlevel(${space.path})`)),
  )
  const archived = path.find((p) => p.archived)
  if (archived && watch)
    return yield* refuse(
      archived.id === head.id
        ? `${head.name} is archived`
        : `${head.name} is archived under ${archived.name}`,
    )

  // The egress gate, read live: the space's own flag, its ancestors', and
  // the workspace floor — the same resolver every outbound call answers to.
  const sensitivity = yield* sensitivityFor(spaceId).pipe(
    Effect.catchTags({
      SensitivityReadFailed: (e) =>
        Effect.fail(new ContextQueryFailed({ cause: e.cause })),
      SensitivityEntityNotFound: () =>
        Effect.fail(refuse(`no space ${spaceId}`)),
    }),
  )
  let sensitive = sensitivity.sensitivity === 'sensitive'
  if (sensitivity.sensitivity === 'sensitive' && watch) {
    const via =
      sensitivity.via.kind === 'space'
        ? ` (via ${sensitivity.via.name})`
        : sensitivity.via.kind === 'default'
          ? ' (the workspace default)'
          : ''
    return yield* refuse(
      `${head.name} is sensitive${via} — a watch brief never leaves for it`,
    )
  }
  const pathIds = path.map((p) => p.id)

  // ---------- the subtree, pruned at archived and sensitive nodes ----------
  const below = yield* query(() =>
    db
      .select({
        id: space.entityId,
        parentId: space.parentId,
        name: entity.canonicalName,
        archived: sql<boolean>`${space.archivedAt} is not null`,
        sensitive: entity.sensitive,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(
        sql`${space.path} <@ ${head.path} and ${space.entityId} <> ${head.id}`,
      )
      .orderBy(asc(entity.canonicalName), asc(space.entityId)),
  )
  const childrenOf = new Map<string, Array<(typeof below)[number]>>()
  for (const s of below) {
    if (s.parentId === null) continue
    const list = childrenOf.get(s.parentId) ?? []
    list.push(s)
    childrenOf.set(s.parentId, list)
  }
  const kept: Array<string> = [head.id]
  const walk = (id: string): ReadonlyArray<{ id: string; name: string }> =>
    (childrenOf.get(id) ?? []).filter(
      (c) => !c.archived && (!watch || !c.sensitive),
    )
  const collect = (id: string): void => {
    for (const c of walk(id)) {
      kept.push(c.id)
      collect(c.id)
    }
  }
  collect(head.id)
  const keptSet = new Set(kept)
  if (below.some((s) => keptSet.has(s.id) && s.sensitive)) sensitive = true

  const counts = new Map(
    (yield* query(() =>
      db
        .select({
          spaceId: entitySpace.spaceId,
          n: sql<number>`count(*)::int`,
        })
        .from(entitySpace)
        .innerJoin(entity, eq(entity.id, entitySpace.entityId))
        .where(
          and(
            inArray(entitySpace.spaceId, kept),
            eq(entity.kind, 'company'),
            isNull(entity.mergedIntoId),
          ),
        )
        .groupBy(entitySpace.spaceId),
    )).map((r) => [r.spaceId, r.n]),
  )
  const nodeOf = (id: string, name: string): SpaceBriefNode => ({
    id,
    name,
    companies: counts.get(id) ?? 0,
    children: walk(id).map((c) => nodeOf(c.id, c.name)),
  })

  // ---------- members: companies filed in the kept subtree ----------
  // Sensitive by any input — its own flag, or any space it is filed in or
  // under — and it stays home.
  const memberRows = yield* query(() =>
    db
      .selectDistinctOn([entity.canonicalName, entity.id], {
        id: entity.id,
        name: entity.canonicalName,
        values: entity.values,
        spaceId: entitySpace.spaceId,
        sensitive: sql<boolean>`${entity.sensitive} or exists (
            select 1 from entity_space es
            join space filed on filed.entity_id = es.space_id
            join space anc on anc.path @> filed.path
            join entity ae on ae.id = anc.entity_id
            where es.entity_id = ${entity.id} and ae.sensitive
          )`,
      })
      .from(entitySpace)
      .innerJoin(entity, eq(entity.id, entitySpace.entityId))
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .where(
        and(
          inArray(entitySpace.spaceId, kept),
          eq(entity.kind, 'company'),
          isNull(entity.mergedIntoId),
          watch
            ? and(
                eq(entity.sensitive, false),
                sql`not exists (
            select 1 from entity_space es
            join space filed on filed.entity_id = es.space_id
            join space anc on anc.path @> filed.path
            join entity ae on ae.id = anc.entity_id
            where es.entity_id = ${entity.id} and ae.sensitive
          )`,
              )
            : undefined,
        ),
      )
      .orderBy(asc(entity.canonicalName), asc(entity.id), asc(space.path)),
  )
  if (memberRows.some((m) => m.sensitive)) sensitive = true
  const shown = memberRows.slice(0, BRIEF_MEMBERS_MAX)
  const domains = new Map<string, Array<string>>()
  if (shown.length > 0)
    for (const a of yield* query(() =>
      db
        .select({
          entityId: entityAlias.entityId,
          value: entityAlias.valueNorm,
        })
        .from(entityAlias)
        .where(
          and(
            inArray(
              entityAlias.entityId,
              shown.map((m) => m.id),
            ),
            eq(entityAlias.kind, 'domain'),
          ),
        )
        .orderBy(asc(entityAlias.createdAt), asc(entityAlias.id)),
    )) {
      const list = domains.get(a.entityId) ?? []
      list.push(a.value)
      domains.set(a.entityId, list)
    }
  const members = shown.map((m): SpaceBriefMember => {
    const values: { [slug: string]: JsonValue } = {}
    for (const slug of BRIEF_KEY_SLUGS) {
      if (!Object.hasOwn(m.values, slug)) continue
      const v = m.values[slug]
      if (v !== null) values[slug] = v
    }
    const keyed: JsonObject = values
    return {
      entityId: m.id,
      name: m.name,
      spaceId: m.spaceId,
      domains: domains.get(m.id) ?? [],
      values: keyed,
    }
  })

  // ---------- memos on the path: filed there, or tagged in ----------
  const filedMemos = yield* query(() =>
    db
      .select({ spaceId: entitySpace.spaceId, n: note })
      .from(entitySpace)
      .innerJoin(note, eq(note.entityId, entitySpace.entityId))
      .innerJoin(entity, eq(entity.id, note.entityId))
      .where(
        and(
          inArray(entitySpace.spaceId, pathIds),
          eq(note.kind, 'memo'),
          isNull(entity.mergedIntoId),
          readableNote(reader.id),
        ),
      )
      .orderBy(desc(note.updatedAt), asc(note.entityId)),
  )
  const tagged = yield* memosTaggedIn(pathIds, reader.id)
  const depth = new Map(pathIds.map((id, i) => [id, i]))
  const seen = new Set<string>()
  const memos: Array<SpaceBriefMemo> = []
  // The subject's own memos first, then up the path.
  for (const m of [...filedMemos, ...tagged].sort(
    (a, b) => (depth.get(b.spaceId) ?? 0) - (depth.get(a.spaceId) ?? 0),
  )) {
    if (seen.has(m.n.entityId)) continue
    seen.add(m.n.entityId)
    if (!canRead(reader, m.n))
      return yield* new ContextLeak({
        ref: `memo:${m.n.entityId}`,
        message: 'canRead refused a memo in a space brief',
      })
    const ref: Ref = `memo:${m.n.entityId}`
    memos.push({
      ref,
      spaceId: m.spaceId,
      title: m.n.title,
      body: truncate(m.n.bodyMd, MEMO_MAX),
      updatedAt: m.n.updatedAt.toISOString(),
    })
  }

  // ---------- terms scoped to the path ----------
  const terms = (yield* query(() =>
    db
      .select()
      .from(term)
      .where(inArray(term.spaceId, pathIds))
      .orderBy(asc(term.name), asc(term.entityId)),
  )).map((t): SpaceBriefTerm => {
    const ref: Ref = `term:${t.entityId}`
    return {
      ref,
      spaceId: t.spaceId ?? head.id,
      name: t.name,
      aliases: t.aliases,
      definition: truncate(t.definitionMd, TERM_MAX),
    }
  })

  return {
    brief: {
      space: { id: head.id, name: head.name, criteria: head.criteria },
      path: path.map((p) => ({ id: p.id, name: p.name })),
      memos,
      terms,
      members,
      memberCount: memberRows.length,
      tree: nodeOf(head.id, head.name),
    },
    sensitive,
    reveals: [...kept, ...shown.map((m) => m.id)],
  }
})
