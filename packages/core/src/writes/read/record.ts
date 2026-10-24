import { Effect, Schema } from 'effect'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  document,
  entity,
  entitySpace,
  link,
  note,
  objectDef,
  space,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import type { Json } from '@spaces/db/json'
import { getRegistryByObjectId } from '../attributes/values'
import { isDerived } from '../../attributes/relationship'
import { renderAttribute } from '../../context/render'
import { canRead } from '../../read-policy'
import { documentWidenedSql, noteWidenedSql } from './can-read-sql'
import { recordRelationsProgram } from './relations'

/**
 * One record, read as a given reader: the MCP `get_record` and the plugin
 * SDK's `Read.entity` are this one read, so a merged-away id, an unreadable
 * note and the registry shape mean the same thing to an assistant and to a
 * plugin.
 * - Registry-shaped: its object, every live attribute in registry order with
 *   the stored value and its assembler line, its links both ways and its
 *   spaces. A relationship's inverse half is listed under its own slug,
 *   marked `derived`, resolved from the owner's links.
 * - canRead is the token user's, at every door a private note could leave
 *   through: the record itself (not found, not refused — its existence is
 *   not disclosed) and the far end of every link. Nothing here writes.
 * - `resolveEntityRefProgram` lets `get_context(entity)` take a name as well
 *   as an id.
 */

export class McpToolRefused extends Schema.TaggedError<McpToolRefused>()(
  'McpToolRefused',
  { message: Schema.String },
) {}

export class McpToolQueryFailed extends Schema.TaggedError<McpToolQueryFailed>()(
  'McpToolQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new McpToolQueryFailed({ cause }),
  })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_MATCHES_SHOWN = 5

type Reader = { id: string }

/**
 * The ids among `ids` that `reader` may not read: a note or a document
 * private to someone else and not widened to them.
 */
const unreadableIds = Effect.fn('unreadableIds')(function* (
  reader: Reader,
  ids: ReadonlyArray<string>,
): Effect.fn.Return<Set<string>, McpToolQueryFailed> {
  if (ids.length === 0) return new Set()
  const [notes, documents] = yield* query(() =>
    Promise.all([
      db
        .select({
          id: note.entityId,
          visibility: note.visibility,
          authorId: note.authorId,
          widened: noteWidenedSql(reader.id),
        })
        .from(note)
        .where(inArray(note.entityId, [...ids])),
      db
        .select({
          id: document.entityId,
          visibility: document.visibility,
          authorId: document.authorId,
          widened: documentWidenedSql(reader.id),
        })
        .from(document)
        .where(inArray(document.entityId, [...ids])),
    ]),
  )
  return new Set(
    [...notes, ...documents]
      .filter((r) => !canRead(reader, r))
      .map((r) => r.id),
  )
})

/** The kinds `unreadableIds` can hide. */
const GATED = new Set(['note', 'document'])

const notFound = (ref: string) =>
  new McpToolRefused({ message: `No record ${ref}` })

/**
 * An id, or an exact (case-insensitive) record name, to one record id the
 * reader may see. A name that fits several records refuses, listing them,
 * so the assistant asks again by id.
 */
export const resolveEntityRefProgram = Effect.fn('resolveEntityRefProgram')(
  function* (
    reader: Reader,
    ref: string,
  ): Effect.fn.Return<string, McpToolRefused | McpToolQueryFailed> {
    const wanted = ref.trim()
    if (UUID.test(wanted)) return wanted.toLowerCase()
    if (!wanted) return yield* notFound('with an empty name')
    const rows = yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
        })
        .from(entity)
        .where(
          and(
            isNull(entity.mergedIntoId),
            sql`lower(${entity.canonicalName}) = lower(${wanted})`,
          ),
        )
        .orderBy(asc(entity.kind), asc(entity.id)),
    )
    const hidden = yield* unreadableIds(
      reader,
      rows.filter((r) => GATED.has(r.kind)).map((r) => r.id),
    )
    const visible = rows.filter((r) => !hidden.has(r.id))
    const only = visible.at(0)
    if (!only) return yield* notFound(`named "${wanted}"`)
    if (visible.length > 1)
      return yield* new McpToolRefused({
        message: `${visible.length} records are named "${wanted}" — ask again by id: ${visible
          .slice(0, NAME_MATCHES_SHOWN)
          .map((r) => `${r.name} (${r.kind}, ${r.id})`)
          .join('; ')}`,
      })
    return only.id
  },
)

export type RecordAttribute = {
  slug: string
  name: string
  type: string
  /** The stored value, as the registry's type holds it; null when unset. */
  value: Json
  /** The assembler's rendering, `Name: value` — null when unset. */
  text: string | null
  /** The inverse half of a relationship: read from the owner's links. */
  derived?: true
}

export type RecordLink = {
  direction: 'out' | 'in'
  relation: string
  /** The reference attribute an `references` edge materializes; else empty. */
  attrSlug: string
  source: string
  entity: { id: string; kind: string; name: string }
}

export type McpRecord = {
  id: string
  kind: string
  name: string
  /** Set when the id asked for was merged away and this is its survivor. */
  mergedFrom: string | null
  object: { id: string; slug: string; singular: string; plural: string } | null
  attributes: Array<RecordAttribute>
  links: Array<RecordLink>
  spaces: Array<{ id: string; name: string }>
}

export const getRecordProgram = Effect.fn('getRecordProgram')(function* (
  reader: Reader,
  id: string,
): Effect.fn.Return<McpRecord, McpToolRefused | McpToolQueryFailed> {
  if (!UUID.test(id)) return yield* notFound(id)
  const load = (entityId: string) =>
    query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
          objectId: entity.objectId,
          values: entity.values,
          mergedIntoId: entity.mergedIntoId,
        })
        .from(entity)
        .where(eq(entity.id, entityId)),
    ).pipe(Effect.map((rows) => rows.at(0)))

  let head = yield* load(id)
  let mergedFrom: string | null = null
  if (head?.mergedIntoId) {
    mergedFrom = head.id
    head = yield* load(head.mergedIntoId)
  }
  if (!head) return yield* notFound(id)
  if ((yield* unreadableIds(reader, [head.id])).has(head.id))
    return yield* notFound(id)
  const seedId = head.id
  const values = head.values

  // ---------- the object and its registry ----------
  const objectId = head.objectId
  const object = objectId
    ? ((yield* query(() =>
        db
          .select({
            id: objectDef.id,
            slug: objectDef.slug,
            singular: objectDef.singular,
            plural: objectDef.plural,
          })
          .from(objectDef)
          .where(eq(objectDef.id, objectId)),
      )).at(0) ?? null)
    : null
  const defs = objectId
    ? yield* query(() => getRegistryByObjectId(objectId, { derived: true }))
    : []
  // The inverse halves resolved, so both sides of a relationship read here.
  const relations = yield* recordRelationsProgram(seedId).pipe(
    Effect.mapError((e) => new McpToolQueryFailed({ cause: e.cause })),
  )
  const valueOf = (d: (typeof defs)[number]): Json =>
    isDerived(d)
      ? (relations.find((h) => h.derived && h.slug === d.slug)?.value ?? null)
      : (values[d.slug] ?? null)

  // names for the reference attributes' rendering — records and people
  const refIds = new Set<string>()
  for (const d of defs) {
    if (d.type !== 'record_reference' && d.type !== 'actor_reference') continue
    const v = valueOf(d)
    if (v == null) continue
    for (const x of Array.isArray(v) ? v : [v]) refIds.add(String(x))
  }
  const names = new Map<string, string>()
  const recordIds = [...refIds].filter((x) => UUID.test(x))
  if (recordIds.length > 0) {
    const hiddenRefs = yield* unreadableIds(reader, recordIds)
    for (const r of yield* query(() =>
      db
        .select({ id: entity.id, name: entity.canonicalName })
        .from(entity)
        .where(inArray(entity.id, recordIds)),
    ))
      if (!hiddenRefs.has(r.id)) names.set(r.id, r.name)
  }
  if (refIds.size > 0)
    for (const u of yield* query(() =>
      db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, [...refIds])),
    ))
      names.set(u.id, u.name)

  const attributes: Array<RecordAttribute> = defs.map((d) => {
    const value = valueOf(d)
    return {
      slug: d.slug,
      name: d.name,
      type: d.type,
      value,
      text: renderAttribute(d, value, (x) => names.get(x)),
      ...(isDerived(d) ? { derived: true as const } : {}),
    }
  })

  // ---------- links, both directions, canRead on the far end ----------
  const edges = yield* query(() =>
    db
      .select({
        from: link.fromEntityId,
        to: link.toEntityId,
        relation: link.relation,
        attrSlug: link.attrSlug,
        source: link.source,
      })
      .from(link)
      .where(or(eq(link.fromEntityId, seedId), eq(link.toEntityId, seedId)))
      .orderBy(asc(link.relation), asc(link.id)),
  )
  const otherIds = [
    ...new Set(edges.map((e) => (e.from === seedId ? e.to : e.from))),
  ]
  const others = new Map<string, { kind: string; name: string }>()
  if (otherIds.length > 0)
    for (const o of yield* query(() =>
      db
        .select({
          id: entity.id,
          kind: entity.kind,
          name: entity.canonicalName,
        })
        .from(entity)
        .where(inArray(entity.id, otherIds)),
    ))
      others.set(o.id, { kind: o.kind, name: o.name })
  const hidden = yield* unreadableIds(
    reader,
    otherIds.filter((x) => GATED.has(others.get(x)?.kind ?? '')),
  )
  const links: Array<RecordLink> = []
  for (const e of edges) {
    const otherId = e.from === seedId ? e.to : e.from
    const other = others.get(otherId)
    if (!other || hidden.has(otherId)) continue
    links.push({
      direction: e.from === seedId ? 'out' : 'in',
      relation: e.relation,
      attrSlug: e.attrSlug,
      source: e.source,
      entity: { id: otherId, kind: other.kind, name: other.name },
    })
  }

  // ---------- spaces it is tagged into ----------
  const spaces = yield* query(() =>
    db
      .select({ id: space.entityId, name: entity.canonicalName })
      .from(entitySpace)
      .innerJoin(space, eq(space.entityId, entitySpace.spaceId))
      .innerJoin(entity, eq(entity.id, space.entityId))
      .where(eq(entitySpace.entityId, seedId))
      .orderBy(asc(entity.canonicalName), asc(space.entityId)),
  )

  return {
    id: seedId,
    kind: head.kind,
    name: head.name,
    mergedFrom,
    object,
    attributes,
    links,
    spaces,
  }
})
