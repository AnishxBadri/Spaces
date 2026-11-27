import { Effect } from 'effect'
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  chunk,
  document,
  entity,
  entityAlias,
  entitySpace,
  link,
  objectDef,
  space,
} from '@spaces/db/schema'
import { canReadDocumentSql } from '@spaces/core/writes/read/can-read-sql'
import { documentFilingEdgesProgram } from '#/lib/server/shared'
import { documentsQuery } from './query'

/**
 * What the `File under…` popover offers: the records and spaces a file can
 * be filed under, with what it is filed under already.
 * - Outside the server-fn modules: the barrel ships plain exports to the
 *   browser, and a test drives these without a request.
 * - Records carry no read gate of their own; what keeps one out is being
 *   merged away or archived, as in every picker. Spaces are offered only
 *   while live. The file's own text is read only through the document gate.
 */

/** The kinds a file files under; a document or a note is a mention, not a filing. */
const FILING_KINDS = ['company', 'person', 'deal', 'custom'] as const

/** The kinds `Named in the file` looks for, in the order it lists them. */
const NAMED_KINDS = ['company', 'deal', 'person'] as const

/** How many rows each band shows before anything is typed. */
const BAND_ROWS = 5

/** One record or space, as the popover and the rail draw it. */
export type FileUnderOption = {
  readonly target: {
    readonly kind: 'record' | 'space'
    readonly entityId: string
  }
  readonly name: string
  /** The entity's kind (`company`, `custom`…), or `space`. */
  readonly kind: string
  /** A custom record's object: its singular, its plural and its glyph. */
  readonly object: {
    readonly singular: string
    readonly plural: string
    readonly icon: string | null
    readonly slug: string
  } | null
  /** A space's ancestors' names, root first; empty for a record. */
  readonly parents: ReadonlyArray<string>
}

export type FileUnderBand = {
  readonly label: string
  readonly options: ReadonlyArray<FileUnderOption>
}

type SpaceNode = {
  readonly name: string
  readonly parentId: string | null
  readonly archived: boolean
}

/**
 * Every space by id with its ancestors' names and whether it is live (no
 * archived ancestor or self). One read: a workspace's spaces are few.
 */
export const spaceTreeProgram = Effect.fn('fileUnder.spaceTree')(function* () {
  const rows = yield* documentsQuery(() =>
    db
      .select({
        id: space.entityId,
        name: entity.canonicalName,
        parentId: space.parentId,
        archivedAt: space.archivedAt,
      })
      .from(space)
      .innerJoin(entity, eq(entity.id, space.entityId)),
  )
  const nodes = new Map<string, SpaceNode>(
    rows.map((r) => [
      r.id,
      { name: r.name, parentId: r.parentId, archived: r.archivedAt !== null },
    ]),
  )
  const tree = new Map<
    string,
    { name: string; parents: Array<string>; live: boolean }
  >()
  for (const [id, node] of nodes) {
    const parents: Array<string> = []
    let live = !node.archived
    const seen = new Set([id])
    let at = node.parentId
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const up = nodes.get(at)
      if (up === undefined) break
      parents.unshift(up.name)
      if (up.archived) live = false
      at = up.parentId
    }
    tree.set(id, { name: node.name, parents, live })
  }
  return tree
})

type SpaceTree = Effect.Success<ReturnType<typeof spaceTreeProgram>>

const spaceOption = (
  id: string,
  node: { name: string; parents: ReadonlyArray<string> },
): FileUnderOption => ({
  target: { kind: 'space', entityId: id },
  name: node.name,
  kind: 'space',
  object: null,
  parents: node.parents,
})

const recordFields = {
  id: entity.id,
  name: entity.canonicalName,
  kind: entity.kind,
  singular: objectDef.singular,
  plural: objectDef.plural,
  icon: objectDef.icon,
  slug: objectDef.slug,
}

type RecordRow = {
  id: string
  name: string
  kind: string
  singular: string | null
  plural: string | null
  icon: string | null
  slug: string | null
}

const recordOption = (r: RecordRow): FileUnderOption => ({
  target: { kind: 'record', entityId: r.id },
  name: r.name,
  kind: r.kind,
  object:
    r.kind === 'custom' &&
    r.singular !== null &&
    r.plural !== null &&
    r.slug !== null
      ? { singular: r.singular, plural: r.plural, icon: r.icon, slug: r.slug }
      : null,
  parents: [],
})

/** A record a picker may offer: not merged away, not archived. */
const offerableRecord = and(
  isNull(entity.mergedIntoId),
  isNull(entity.archivedAt),
)

/**
 * The records whose names appear in a file's stored text, in the order the
 * text first names them, at most `limit`. Empty for a file the reader may
 * not read or one with no text.
 * - Cheapest first: the file's chunks are joined into one lowered string
 *   once (an uncorrelated subquery the planner runs once), `strpos` prunes
 *   the candidates, and only then a word-boundary match keeps `Exponent`
 *   out of `Exponential`. Names under three characters never match.
 */
export const namedInFileProgram = Effect.fn('fileUnder.namedInFile')(function* (
  viewer: { readonly id: string },
  documentId: string,
  limit: number = BAND_ROWS,
) {
  const readable = yield* documentsQuery(() =>
    db
      .select({ id: document.entityId })
      .from(document)
      .where(
        and(eq(document.entityId, documentId), canReadDocumentSql(viewer.id)),
      ),
  )
  if (readable.length === 0) return []

  const body = sql`(select lower(string_agg(${chunk.text}, ' ')) from ${chunk} where ${chunk.entityId} = ${documentId})`
  const name = sql`lower(${entity.canonicalName})`
  // A name as a regex literal: every character that is not a letter, a
  // digit or a space is escaped, which an advanced regex reads literally.
  const literal = sql`regexp_replace(${name}, '([^[:alnum:][:space:]])', '\\\\\\1', 'g')`
  const at = sql<number>`strpos(${body}, ${name})`
  const rows = yield* documentsQuery(() =>
    db
      .select({ ...recordFields, at })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          inArray(entity.kind, [...NAMED_KINDS]),
          offerableRecord,
          sql`char_length(${entity.canonicalName}) >= 3`,
          sql`${at} > 0`,
          sql`${body} ~ ('(^|[^[:alnum:]])' || ${literal} || '($|[^[:alnum:]])')`,
        ),
      )
      .orderBy(
        sql`array_position(array['company','deal','person']::text[], ${entity.kind}::text)`,
        at,
      )
      .limit(limit),
  )
  return rows.map(recordOption)
})

/**
 * What the reader filed under most recently, newest first, at most `limit`.
 * Both filing tables record who made each edge (`created_by`), so this is
 * the reader's own live filings of any file; an edge since removed is not
 * remembered. Archived and merged targets are left out.
 */
export const recentFilingTargetsProgram = Effect.fn('fileUnder.recent')(
  function* (
    viewer: { readonly id: string },
    tree: SpaceTree,
    limit: number = BAND_ROWS,
  ) {
    const [records, spaces] = yield* documentsQuery(() =>
      Promise.all([
        db
          .select({ id: link.toEntityId, at: link.createdAt })
          .from(link)
          .innerJoin(document, eq(document.entityId, link.fromEntityId))
          .where(
            and(eq(link.relation, 'tagged_in'), eq(link.createdBy, viewer.id)),
          )
          .orderBy(desc(link.createdAt))
          .limit(limit * 6),
        db
          .select({ id: entitySpace.spaceId, at: entitySpace.createdAt })
          .from(entitySpace)
          .innerJoin(document, eq(document.entityId, entitySpace.entityId))
          .where(eq(entitySpace.createdBy, viewer.id))
          .orderBy(desc(entitySpace.createdAt))
          .limit(limit * 6),
      ]),
    )
    const order: Array<string> = []
    for (const r of [...records, ...spaces].sort(
      (a, b) => b.at.getTime() - a.at.getTime(),
    ))
      if (!order.includes(r.id)) order.push(r.id)

    const recordIds = order.filter((id) => !tree.has(id))
    const found =
      recordIds.length === 0
        ? []
        : yield* documentsQuery(() =>
            db
              .select(recordFields)
              .from(entity)
              .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
              .where(
                and(
                  inArray(entity.id, recordIds),
                  inArray(entity.kind, [...FILING_KINDS]),
                  offerableRecord,
                ),
              ),
          )
    const byId = new Map(found.map((r) => [r.id, recordOption(r)]))
    const out: Array<FileUnderOption> = []
    for (const id of order) {
      const node = tree.get(id)
      const option =
        node === undefined
          ? byId.get(id)
          : node.live
            ? spaceOption(id, node)
            : undefined
      if (option !== undefined) out.push(option)
      if (out.length === limit) break
    }
    return out
  },
)

/** The newest records, for a reader who has filed nothing and a file that names nobody. */
const newestRecords = Effect.fn('fileUnder.newest')(function* (limit: number) {
  const rows = yield* documentsQuery(() =>
    db
      .select(recordFields)
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(and(inArray(entity.kind, [...FILING_KINDS]), offerableRecord))
      .orderBy(desc(entity.createdAt))
      .limit(limit),
  )
  return rows.map(recordOption)
})

/** The kind bands a search is grouped under, in this order; custom objects before Spaces' end. */
const KIND_BANDS: ReadonlyArray<readonly [string, string]> = [
  ['company', 'Companies'],
  ['deal', 'Deals'],
  ['person', 'People'],
]

/**
 * A typed search: records by name or alias and live spaces by name,
 * grouped under kind bands (`Companies`, `Deals`, `People`, `Spaces`, then
 * each custom object's plural).
 */
const searchBands = Effect.fn('fileUnder.search')(function* (
  q: string,
  tree: SpaceTree,
) {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const records = yield* documentsQuery(() =>
    db
      .selectDistinctOn([entity.id], recordFields)
      .from(entity)
      .leftJoin(entityAlias, eq(entityAlias.entityId, entity.id))
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(
        and(
          inArray(entity.kind, [...FILING_KINDS]),
          offerableRecord,
          or(
            ilike(entity.canonicalName, pattern),
            and(
              eq(entityAlias.kind, 'name'),
              ilike(entityAlias.valueNorm, pattern),
            ),
          ),
        ),
      )
      .limit(24),
  )
  const options = records
    .map(recordOption)
    .sort((a, b) => a.name.localeCompare(b.name))
  const needle = q.toLowerCase()
  const spaces = [...tree]
    .filter(([, node]) => node.live && node.name.toLowerCase().includes(needle))
    .map(([id, node]) => spaceOption(id, node))
    .sort(
      (a, b) =>
        a.parents.join(' ').localeCompare(b.parents.join(' ')) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 8)

  const bands: Array<FileUnderBand> = []
  for (const [kind, label] of KIND_BANDS) {
    const of = options.filter((o) => o.kind === kind)
    if (of.length > 0) bands.push({ label, options: of })
  }
  if (spaces.length > 0) bands.push({ label: 'Spaces', options: spaces })
  const objects = new Map<string, Array<FileUnderOption>>()
  for (const o of options)
    if (o.object !== null)
      objects.set(o.object.plural, [...(objects.get(o.object.plural) ?? []), o])
  for (const [plural, of] of objects) bands.push({ label: plural, options: of })
  return bands
})

/**
 * The popover's whole read: what the file is filed under (its ids), and the
 * bands to offer. With nothing typed, `Named in the file` then `Recent`
 * (without the rows already named); when both are empty, the newest
 * records stand in as `Recent`, so the popover never opens empty.
 */
export const fileUnderOptionsProgram = Effect.fn('fileUnderOptions')(function* (
  viewer: { readonly id: string },
  documentId: string,
  q: string,
) {
  // A file the reader may not read says nothing of where it is filed.
  const readable = yield* documentsQuery(() =>
    db
      .select({ id: document.entityId })
      .from(document)
      .where(
        and(eq(document.entityId, documentId), canReadDocumentSql(viewer.id)),
      ),
  )
  if (readable.length === 0) return { filed: [], bands: [] }
  const edges = yield* documentFilingEdgesProgram([documentId])
  const filed = (edges.get(documentId) ?? []).map((e) => e.id)
  const tree = yield* spaceTreeProgram()
  const typed = q.trim()
  if (typed !== '') return { filed, bands: yield* searchBands(typed, tree) }

  const named = yield* namedInFileProgram(viewer, documentId)
  const namedIds = new Set(named.map((o) => o.target.entityId))
  const recent = (yield* recentFilingTargetsProgram(
    viewer,
    tree,
    BAND_ROWS + named.length,
  ))
    .filter((o) => !namedIds.has(o.target.entityId))
    .slice(0, BAND_ROWS)
  const bands: Array<FileUnderBand> = []
  if (named.length > 0)
    bands.push({ label: 'Named in the file', options: named })
  if (recent.length > 0) bands.push({ label: 'Recent', options: recent })
  if (bands.length === 0)
    bands.push({ label: 'Recent', options: yield* newestRecords(BAND_ROWS) })
  return { filed, bands }
})
