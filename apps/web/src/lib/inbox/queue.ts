import { Effect, Schema } from 'effect'
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  duplicateCandidate,
  entity,
  objectDef,
  suggestion,
  suggestionKind,
} from '@spaces/db/schema'
import type { AttributeOptions } from '@spaces/db/schema/attributes'
import type { DuplicateReason } from '@spaces/db/schema/entities'
import { toObjectKind } from '@spaces/core/attributes/registry'
import { objectIdForKindAsync } from '#/lib/attributes/objects'
import { getRegistryByObjectId } from '#/lib/attributes/values'
import type { SuggestionKind } from '#/lib/ai/propose'
import { resolveRefsProgram } from '#/lib/context/names'
import type { ResolvedRef } from '#/lib/context/names'
import { jsonRecord } from '#/lib/json'
import type { Json } from '#/lib/json'
import { entityContext } from './context'
import type { InboxSide } from './context'

/**
 * The review inbox's queue (SPA-76, SPA-98) — one list over typed rows and
 * one count over the tables behind them. `lib/server/inbox.ts` is the door
 * (session check, then these programs through `effectFn()`); the programs
 * live here, outside `lib/server/`, so the suite can drive them without a
 * request and nothing below reaches the client bundle (SPA-155).
 *
 * Two lanes today: `duplicate_candidate` (the sweep's pairs) and
 * `suggestion` (the AI layer's proposals, spec-ai-substrate.md §10). A later
 * lane adds a member to `InboxRow`, a branch here and a renderer in
 * `routes/_app/inbox.tsx` — never a page.
 */

export class InboxQueryFailed extends Schema.TaggedError<InboxQueryFailed>()(
  'InboxQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InboxQueryFailed({ cause }),
  })

/**
 * A pair the sweep proposed, still open. The `kind` is the discriminant the
 * page dispatches on — it is stored nowhere, it is what this lane *is*.
 */
export type DuplicateCandidateRow = {
  kind: 'duplicate_candidate'
  id: string
  score: number
  reason: DuplicateReason
  /** When the sweep proposed it — the card's only member, so its recency. */
  latestAt: string
  a: InboxSide
  b: InboxSide
}

/** The record a suggestion card is about: enough for a chip and a link. */
export type SuggestionRecord = {
  id: string
  name: string
  kind: string
  objectSlug: string | null
  objectSingular: string | null
}

/**
 * One proposed field of an `attribute_patch`, carried with the attribute
 * definition the page renders it through — the same `def` shape the record
 * table's cells take, so the value reads the way that column reads it.
 */
export type SuggestionField = {
  slug: string
  name: string
  type: string
  options: AttributeOptions | null
  isSystem: boolean
  value: Json
}

/**
 * A citation: the stored ref resolved server-side (`names.ts`) — the words
 * `cite.ts` turns it into, the survivor it lands on, or `missing`.
 */
export type SuggestionCitation = ResolvedRef

export type SuggestionItem = {
  id: string
  kind: SuggestionKind
  payload: Json
  rationale: string | null
  citations: Array<SuggestionCitation>
  /**
   * The patch's fields against the record's live registry, for
   * `attribute_patch`. Null for every kind that has no sub-renderer yet — the
   * card prints the payload instead.
   */
  fields: Array<SuggestionField> | null
  createdAt: string
}

/**
 * Every open suggestion on one record: the unit of decision is the record,
 * each member accepted or rejected on its own. `id` is the record's id —
 * one card per record, so it is unique within the lane.
 */
export type SuggestionRow = {
  kind: 'suggestion'
  id: string
  record: SuggestionRecord
  /** Newest first. */
  suggestions: Array<SuggestionItem>
  /** The newest member's `created_at` — where the card sorts in the queue. */
  latestAt: string
}

/**
 * Every row the inbox can hold. Add a lane by adding a member here and a
 * renderer in `routes/_app/inbox.tsx` — the queue, the count and the page
 * follow. Nothing else in the app switches on this union.
 */
export type InboxRow = DuplicateCandidateRow | SuggestionRow

export type InboxKind = InboxRow['kind']

/** `open` is the whole queue; `byKind` is what each lane contributes. */
export type InboxCounts = {
  open: number
  byKind: Record<InboxKind, number>
}

/**
 * What the queue is narrowed to. `record` set: only rows about that entity —
 * its suggestion card, and every open pair it is either side of (SPA-114,
 * the record rail's "Waiting" chips link here). Null: the whole queue.
 */
export type InboxScope = { record: string | null }

const ALL: InboxScope = { record: null }

const listDuplicateLane = Effect.fn('listDuplicateLane')(function* (
  scope: InboxScope,
): Effect.fn.Return<Array<DuplicateCandidateRow>, InboxQueryFailed> {
  const open = eq(duplicateCandidate.status, 'open')
  const rows = yield* query(() =>
    db
      .select()
      .from(duplicateCandidate)
      .where(
        scope.record === null
          ? open
          : and(
              open,
              or(
                eq(duplicateCandidate.entityA, scope.record),
                eq(duplicateCandidate.entityB, scope.record),
              ),
            ),
      )
      .orderBy(desc(duplicateCandidate.createdAt)),
  )
  return yield* query(() =>
    Promise.all(
      rows.map(async (r): Promise<DuplicateCandidateRow> => ({
        kind: 'duplicate_candidate',
        id: r.id,
        score: r.score,
        reason: r.reason,
        latestAt: r.createdAt.toISOString(),
        a: await entityContext(r.entityA),
        b: await entityContext(r.entityB),
      })),
    ),
  )
})

/** The fields of an `attribute_patch` payload, against the live registry. */
function patchFields(
  payload: Json,
  registry: ReadonlyArray<{
    slug: string
    name: string
    type: string
    options: AttributeOptions
    isSystem: boolean
  }>,
): Array<SuggestionField> | null {
  const envelope = jsonRecord(payload)
  const fields: Array<SuggestionField> = []
  for (const [slug, raw] of Object.entries(envelope)) {
    const def = registry.find((d) => d.slug === slug)
    const field = jsonRecord(raw)
    // A slug the registry no longer carries, or an envelope without a value,
    // is not a field this card can draw — the payload view says it instead.
    if (!def || !('value' in field)) return null
    fields.push({
      slug,
      name: def.name,
      type: def.type,
      options: def.options,
      isSystem: def.isSystem,
      value: field.value,
    })
  }
  return fields.length > 0 ? fields : null
}

const listSuggestionLane = Effect.fn('listSuggestionLane')(function* (
  scope: InboxScope,
): Effect.fn.Return<Array<SuggestionRow>, InboxQueryFailed> {
  const isOpen = eq(suggestion.status, 'open')
  const open = yield* query(() =>
    db
      .select()
      .from(suggestion)
      .where(
        scope.record === null
          ? isOpen
          : and(isOpen, eq(suggestion.entityId, scope.record)),
      )
      .orderBy(desc(suggestion.createdAt), desc(suggestion.id)),
  )
  if (open.length === 0) return []

  const entityIds = [...new Set(open.map((s) => s.entityId))]
  const heads = yield* query(() =>
    db
      .select({
        id: entity.id,
        name: entity.canonicalName,
        kind: entity.kind,
        objectId: entity.objectId,
        objectSlug: objectDef.slug,
        objectSingular: objectDef.singular,
      })
      .from(entity)
      .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
      .where(inArray(entity.id, entityIds)),
  )
  const headOf = new Map(heads.map((h) => [h.id, h]))

  // One registry per object, not per record: a card draws its patch's
  // values through the attribute definitions the record's object carries.
  const registries = new Map<
    string,
    Awaited<ReturnType<typeof getRegistryByObjectId>>
  >()
  const registryOf = (head: (typeof heads)[number]) =>
    query(async () => {
      const core = toObjectKind(head.kind)
      const objectId =
        head.objectId ??
        (core === null ? null : await objectIdForKindAsync(core))
      if (objectId === null) return []
      const hit = registries.get(objectId)
      if (hit) return hit
      const reg = await getRegistryByObjectId(objectId)
      registries.set(objectId, reg)
      return reg
    })

  // Every ref on the lane in one resolve — one query per ref kind, not per
  // ref — then handed back to each suggestion by position.
  const resolved = yield* resolveRefsProgram(open.flatMap((s) => s.refs)).pipe(
    Effect.mapError((e) => new InboxQueryFailed({ cause: e })),
  )
  const citationsOf = new Map<string, Array<SuggestionCitation>>()
  let at = 0
  for (const s of open)
    citationsOf.set(s.id, resolved.slice(at, (at += s.refs.length)))

  // `open` is newest first, so the first member seen for a record is its
  // newest and Map insertion order is already the queue's order.
  const cards = new Map<string, SuggestionRow>()
  for (const s of open) {
    const head = headOf.get(s.entityId)
    if (!head) continue
    const registry = yield* registryOf(head)
    const item: SuggestionItem = {
      id: s.id,
      kind: s.kind,
      payload: s.payload,
      rationale: s.rationale,
      citations: citationsOf.get(s.id) ?? [],
      fields:
        s.kind === 'attribute_patch' ? patchFields(s.payload, registry) : null,
      createdAt: s.createdAt.toISOString(),
    }
    const card = cards.get(s.entityId)
    if (card) card.suggestions.push(item)
    else
      cards.set(s.entityId, {
        kind: 'suggestion',
        id: s.entityId,
        record: {
          id: head.id,
          name: head.name,
          kind: head.kind,
          objectSlug: head.objectSlug,
          objectSingular: head.objectSingular,
        },
        suggestions: [item],
        latestAt: item.createdAt,
      })
  }
  return [...cards.values()]
})

/**
 * The whole queue, newest first by each card's most recent member — a
 * suggestion card by its newest suggestion, a pair by when it was proposed.
 * ISO instants compare lexically. A `record` scope narrows both lanes to
 * that one entity; omitted, it is the whole queue.
 */
export const listInboxProgram = Effect.fn('listInboxProgram')(function* (
  scope: InboxScope = ALL,
): Effect.fn.Return<Array<InboxRow>, InboxQueryFailed> {
  const [pairs, suggestions] = yield* Effect.all([
    listDuplicateLane(scope),
    listSuggestionLane(scope),
  ])
  const rows: Array<InboxRow> = [...suggestions, ...pairs]
  return rows.sort((x, y) =>
    x.latestAt === y.latestAt ? 0 : x.latestAt < y.latestAt ? 1 : -1,
  )
})

/**
 * One round trip, one `UNION ALL` of the same two columns per lane — never
 * the list itself. Each arm is an aggregate with no `GROUP BY`, so it always
 * answers one row, zero included, and every caller keeps reading `byKind`:
 * Today's cell is `open`, /companies' banner is `byKind.duplicate_candidate`.
 */
export const countOpenInboxProgram = Effect.fn('countOpenInboxProgram')(
  function* (): Effect.fn.Return<InboxCounts, InboxQueryFailed> {
    const rows = yield* query(() =>
      db
        .select({
          kind: sql<InboxKind>`'suggestion'`.as('kind'),
          value: count(),
        })
        .from(suggestion)
        .where(eq(suggestion.status, 'open'))
        .unionAll(
          db
            .select({
              kind: sql<InboxKind>`'duplicate_candidate'`.as('kind'),
              value: count(),
            })
            .from(duplicateCandidate)
            .where(eq(duplicateCandidate.status, 'open')),
        ),
    )
    const byKind: Record<InboxKind, number> = {
      duplicate_candidate: 0,
      suggestion: 0,
    }
    let open = 0
    for (const row of rows) {
      byKind[row.kind] = row.value
      open += row.value
    }
    return { open, byKind }
  },
)

/** The record the inbox is scoped to, named for the header's chip. */
export type InboxScopeRecord = { id: string; name: string }

/**
 * The scoped record's name, read once for the header — the rows cannot be
 * trusted to carry it, since a record whose last suggestion was just
 * accepted still scopes an empty queue. Null for an id that is not a record.
 */
export const inboxScopeRecordProgram = Effect.fn('inboxScopeRecordProgram')(
  function* (
    id: string,
  ): Effect.fn.Return<InboxScopeRecord | null, InboxQueryFailed> {
    const row = yield* query(() =>
      db
        .select({ id: entity.id, name: entity.canonicalName })
        .from(entity)
        .where(eq(entity.id, id))
        .limit(1),
    )
    return row.at(0) ?? null
  },
)

/** One kind of open suggestion on one record, and how many are waiting. */
export type OpenSuggestionCount = { kind: SuggestionKind; count: number }

/** The enum's declared order — the order the rail draws its chips in. */
const KIND_ORDER: ReadonlyArray<SuggestionKind> = suggestionKind.enumValues

/**
 * The record rail's "Waiting" lane (SPA-114): open suggestions on one
 * record, grouped by kind, in one query — a record page calls it once from
 * its loader, never once per rail section. `GROUP BY` answers no row for a
 * kind with nothing open, so a record with nothing waiting is an empty
 * array, and the rail draws no section at all. Only `open` counts: a
 * rejected suggestion never comes back, as a dismissed pair never does.
 */
export const countOpenSuggestionsProgram = Effect.fn(
  'countOpenSuggestionsProgram',
)(function* (
  entityId: string,
): Effect.fn.Return<Array<OpenSuggestionCount>, InboxQueryFailed> {
  const rows = yield* query(() =>
    db
      .select({ kind: suggestion.kind, count: count() })
      .from(suggestion)
      .where(
        and(eq(suggestion.entityId, entityId), eq(suggestion.status, 'open')),
      )
      .groupBy(suggestion.kind),
  )
  return rows
    .filter((r) => r.count > 0)
    .sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind))
})
