import { Effect, Schema } from 'effect'
import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  aiRun,
  apiToken,
  document,
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
import { isColumnRunTask } from '#/lib/ai/column-run'
import { captureReadSlug } from '#/lib/ai/capture-read'
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

/**
 * Where a suggestion came from (SPA-31). `app`: an in-app feature — a
 * person's click or a worker job. `mcp`: an outside assistant over the MCP
 * server, named by the API token that made it (revoked tokens keep their
 * name: the proposal outlives the credential). `integration`: an integration
 * actor that is not a token.
 */
export type SuggestionOrigin =
  { via: 'app' } | { via: 'mcp'; token: string } | { via: 'integration' }

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
  origin: SuggestionOrigin
  createdAt: string
  /** The run that produced it (SPA-100) — the card's "produced by this run". */
  runId: string | null
}

/**
 * The captured page a card is anchored on (SPA-134): a capture names
 * somebody we hold no record for, so its read's suggestions sit on the
 * document itself, and the card's heading names the page — its title and
 * the address it was captured from — where a record card has its chip.
 */
export type CapturedPage = {
  title: string
  url: string | null
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
  /**
   * Set when the card is a captured page's rather than a record's — the
   * ownerless group, headed by the page. Null for every record card.
   */
  page: CapturedPage | null
  /** Newest first. */
  suggestions: Array<SuggestionItem>
  /** The newest member's `created_at` — where the card sorts in the queue. */
  latestAt: string
}

/**
 * A column run as its inbox header reads it (SPA-122): the `ai_run` row's
 * task, where it stands, and — for a run the daily cap stopped — its
 * summary line (rows done, rows left), which the run writes to
 * `ai_run.error` when it closes.
 */
export type ColumnRunSummary = {
  id: string
  task: string
  status: 'running' | 'done' | 'failed'
  /** The stop line: why the run ended early, with rows done and left. */
  error: string | null
  /** Rows the model was asked about so far — the run's steps. */
  rowsRun: number
  startedAt: string
}

/**
 * Every open suggestion one column run wrote, under one header (SPA-122):
 * the run's summary and "Accept all", which accepts the run's attribute
 * across its suggestions through `acceptColumnProgram`. The members are the
 * ordinary per-record cards, so each is still decided on its own.
 */
export type ColumnRunRow = {
  kind: 'column_run'
  /** The run's id — one row per run, so unique within the lane. */
  id: string
  run: ColumnRunSummary
  /**
   * The attribute the run proposed — what "Accept all" accepts. Null when
   * no member proposes a value (only registry proposals are left), and the
   * header then offers no bulk accept.
   */
  attributeSlug: string | null
  /** Newest first, by each record's newest member. */
  cards: Array<SuggestionRow>
  latestAt: string
}

/**
 * Every row the inbox can hold. Add a lane by adding a member here and a
 * renderer in `routes/_app/inbox.tsx` — the queue, the count and the page
 * follow. Nothing else in the app switches on this union.
 */
export type InboxRow = DuplicateCandidateRow | SuggestionRow | ColumnRunRow

export type InboxKind = InboxRow['kind']

/**
 * The tables a row comes from — what the header tabs and the counts split
 * by. A column run's group is suggestions, gathered; it is not a lane.
 */
export type InboxLane = 'suggestion' | 'duplicate_candidate'

/** `open` is the whole queue; `byKind` is what each lane contributes. */
export type InboxCounts = {
  open: number
  byKind: Record<InboxLane, number>
}

/**
 * What the queue is narrowed to. `record` set: only rows about that entity —
 * its suggestion card, and every open pair it is either side of (SPA-114,
 * the record rail's "Waiting" chips link here). Null: the whole queue.
 */
export type InboxScope = { record: string | null }

const ALL: InboxScope = { record: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
): Effect.fn.Return<Array<SuggestionRow | ColumnRunRow>, InboxQueryFailed> {
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
  // SPA-134: a document is the anchor of a captured page's read; its
  // address is what the card's heading links.
  const docIds = heads.filter((h) => h.kind === 'document').map((h) => h.id)
  const pageUrl = new Map(
    docIds.length === 0
      ? []
      : (yield* query(() =>
          db
            .select({ id: document.entityId, url: document.url })
            .from(document)
            .where(inArray(document.entityId, docIds)),
        )).map((d) => [d.id, d.url]),
  )

  // One registry per object, not per record: a card draws its patch's
  // values through the attribute definitions the record's object carries.
  const registries = new Map<
    string,
    Awaited<ReturnType<typeof getRegistryByObjectId>>
  >()
  const registryOf = (
    head: (typeof heads)[number],
    pageObjectId: string | null,
  ) =>
    query(async () => {
      const core = toObjectKind(head.kind)
      // A captured page's patch reads through the object it was read as.
      const objectId =
        pageObjectId ??
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

  // SPA-31: an MCP proposal carries its API token's id as the integration
  // actor's id — the token's name is what the card labels it with.
  const tokenIds = [
    ...new Set(
      open.flatMap((s) =>
        s.proposedByType === 'integration' &&
        s.proposedById !== null &&
        UUID.test(s.proposedById)
          ? [s.proposedById]
          : [],
      ),
    ),
  ]
  const tokenName = new Map(
    tokenIds.length === 0
      ? []
      : (yield* query(() =>
          db
            .select({ id: apiToken.id, name: apiToken.name })
            .from(apiToken)
            .where(inArray(apiToken.id, tokenIds)),
        )).map((t) => [t.id, t.name]),
  )
  const originOf = (s: (typeof open)[number]): SuggestionOrigin => {
    if (s.proposedByType !== 'integration') return { via: 'app' }
    const token =
      s.proposedById === null ? undefined : tokenName.get(s.proposedById)
    return token === undefined ? { via: 'integration' } : { via: 'mcp', token }
  }

  // SPA-122: a column run's suggestions gather under the run. The runs are
  // read once for the lane; a run that is not a column run (a per-cell
  // press, a deck read) leaves its suggestions on their record's card.
  const runIds = [
    ...new Set(open.flatMap((s) => (s.runId === null ? [] : [s.runId]))),
  ]
  const runs =
    runIds.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              id: aiRun.id,
              task: aiRun.task,
              status: aiRun.status,
              error: aiRun.error,
              rowsRun: sql<number>`jsonb_array_length(${aiRun.steps})::int`,
              startedAt: aiRun.startedAt,
            })
            .from(aiRun)
            .where(inArray(aiRun.id, runIds)),
        )
  const columnRuns = new Map<string, ColumnRunSummary>(
    runs
      .filter((r) => isColumnRunTask(r.task))
      .map((r) => [r.id, { ...r, startedAt: r.startedAt.toISOString() }]),
  )
  // SPA-134: a capture read's run names the object its page was read as.
  const pageSlugOf = new Map(
    runs.flatMap((r) => {
      const slug = captureReadSlug(r.task)
      return slug === null ? [] : [[r.id, slug] as const]
    }),
  )
  const pageSlugs = [...new Set(pageSlugOf.values())]
  const objectIdOfSlug = new Map(
    pageSlugs.length === 0
      ? []
      : (yield* query(() =>
          db
            .select({ id: objectDef.id, slug: objectDef.slug })
            .from(objectDef)
            .where(inArray(objectDef.slug, pageSlugs)),
        )).map((o) => [o.slug, o.id]),
  )
  const pageObjectOf = (s: (typeof open)[number]): string | null => {
    const slug = s.runId === null ? undefined : pageSlugOf.get(s.runId)
    return slug === undefined ? null : (objectIdOfSlug.get(slug) ?? null)
  }
  const groups = new Map<string, Map<string, SuggestionRow>>()

  // `open` is newest first, so the first member seen for a record is its
  // newest and Map insertion order is already the queue's order.
  const cards = new Map<string, SuggestionRow>()
  for (const s of open) {
    const head = headOf.get(s.entityId)
    if (!head) continue
    const pageObjectId = head.kind === 'document' ? pageObjectOf(s) : null
    const registry = yield* registryOf(head, pageObjectId)
    const item: SuggestionItem = {
      id: s.id,
      kind: s.kind,
      payload: s.payload,
      rationale: s.rationale,
      citations: citationsOf.get(s.id) ?? [],
      fields:
        s.kind === 'attribute_patch' ? patchFields(s.payload, registry) : null,
      origin: originOf(s),
      createdAt: s.createdAt.toISOString(),
      runId: s.runId,
    }
    const inRun = s.runId !== null && columnRuns.has(s.runId) ? s.runId : null
    let into = cards
    if (inRun !== null) {
      const group = groups.get(inRun) ?? new Map<string, SuggestionRow>()
      groups.set(inRun, group)
      into = group
    }
    const page: CapturedPage | null =
      pageObjectId === null
        ? null
        : { title: head.name, url: pageUrl.get(head.id) ?? null }
    const card = into.get(s.entityId)
    if (card) {
      card.suggestions.push(item)
      card.page ??= page
    } else
      into.set(s.entityId, {
        kind: 'suggestion',
        id: s.entityId,
        record: {
          id: head.id,
          name: head.name,
          kind: head.kind,
          objectSlug: head.objectSlug,
          objectSingular: head.objectSingular,
        },
        page,
        suggestions: [item],
        latestAt: item.createdAt,
      })
  }
  const runRows = [...groups].flatMap(([runId, group]): Array<ColumnRunRow> => {
    const run = columnRuns.get(runId)
    const members = [...group.values()]
    const newest = members.at(0)
    if (run === undefined || newest === undefined) return []
    // The run proposed one attribute; any member with a value names it.
    const attributeSlug =
      members
        .flatMap((c) => c.suggestions)
        .flatMap((i) => (i.kind === 'attribute_patch' ? (i.fields ?? []) : []))
        .at(0)?.slug ?? null
    return [
      {
        kind: 'column_run',
        id: runId,
        run,
        attributeSlug,
        cards: members,
        latestAt: newest.latestAt,
      },
    ]
  })
  return [...cards.values(), ...runRows]
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
          kind: sql<InboxLane>`'suggestion'`.as('kind'),
          value: count(),
        })
        .from(suggestion)
        .where(eq(suggestion.status, 'open'))
        .unionAll(
          db
            .select({
              kind: sql<InboxLane>`'duplicate_candidate'`.as('kind'),
              value: count(),
            })
            .from(duplicateCandidate)
            .where(eq(duplicateCandidate.status, 'open')),
        ),
    )
    const byKind: Record<InboxLane, number> = {
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
