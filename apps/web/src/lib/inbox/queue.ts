import { Effect, Schema } from 'effect'
import {
  and,
  count,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  aiRun,
  apiToken,
  askThread,
  askTurn,
  document,
  duplicateCandidate,
  entity,
  integration,
  objectDef,
  suggestion,
  suggestionKind,
} from '@spaces/db/schema'
import type { AttributeOptions } from '@spaces/db/schema/attributes'
import type { DuplicateReason } from '@spaces/db/schema/entities'
import { toObjectKind } from '@spaces/core/attributes/registry'
import { objectIdForKindAsync } from '@spaces/core/writes/attributes/objects'
import { getRegistryByObjectId } from '@spaces/core/writes/attributes/values'
import type { SuggestionKind } from '@spaces/core/writes/suggestions/propose'
import {
  DISCOVERY_KINDS,
  isDiscoveryKind,
} from '@spaces/core/writes/suggestions/propose'
import { discoverySpaceOf } from '@spaces/core/ai/discovery'
import { isColumnRunTask } from '#/lib/ai/column-run'
import { captureReadSlug } from '@spaces/core/writes/ai/capture-read'
import { resolveRefsProgram } from '@spaces/core/writes/context/names'
import type { ResolvedRef } from '@spaces/core/writes/context/names'
import { jsonRecord, jsonString } from '@spaces/core/json'
import type { Json } from '@spaces/core/json'
import { entityContext } from './context'
import { duplicateOf } from '../records/notices'
import type { RecordDuplicate } from '../records/notices'
import { JUDGMENT, JUDGMENT_REF } from './review-groups'
import type { InboxSide } from './context'

/**
 * The review inbox's queue: one list over typed rows. The inbox server fns
 * are the door (session check, then these programs through `effectFn()`);
 * the programs live outside the server-fn modules so the suite can drive
 * them without a request and nothing below reaches the client bundle.
 *
 * Two lanes: `duplicate_candidate` (the sweep's pairs) and `suggestion` (the
 * AI layer's proposals). A new lane adds a member to `InboxRow`, a branch
 * here and a renderer in the inbox route — never a page.
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
 * A citation: the stored ref resolved server-side — the words the citation
 * renderer turns it into, the survivor it lands on, or `missing`.
 */
export type SuggestionCitation = ResolvedRef

/**
 * Where a suggestion came from. `app`: an in-app feature — a
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
  /** The run that produced it — the card's "produced by this run". */
  runId: string | null
}

/**
 * The captured page a card is anchored on: a capture names
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
 * A column run as its inbox header reads it: the `ai_run` row's
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
 * Every open suggestion one column run wrote, under one header:
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

/** The space a discovery group is about, labelled by its path of names. */
export type DiscoverySpace = {
  id: string
  name: string
  /** `Proptech / Rental software`. */
  path: string
}

/**
 * A space's open discovery cards (`add_record`, `file_record`) under one
 * head: the space's path, the plugins that found them, the count. Each card
 * is decided on its own; there is no bulk accept.
 */
export type DiscoveryRow = {
  kind: 'discovery'
  /** The space's id — one group per space. */
  id: string
  space: DiscoverySpace
  /** The integrations that proposed the cards, by name, first seen first. */
  via: Array<string>
  /** Newest first. */
  suggestions: Array<SuggestionItem>
  latestAt: string
}

/**
 * Action cards an Ask thread left undecided, under a head naming the thread.
 * Shown so only to the thread's author, since threads are private;
 * anyone else sees them as ordinary record cards.
 */
export type AskCardsRow = {
  kind: 'ask_cards'
  /** The thread's id — one group per thread. */
  id: string
  title: string
  /** Newest first, by each record's newest member. */
  cards: Array<SuggestionRow>
  latestAt: string
}

/**
 * Every row the inbox can hold. Add a lane by adding a member here and a
 * renderer in the inbox route — the queue, the count and the page
 * follow. Nothing else in the app switches on this union.
 */
export type InboxRow =
  | DuplicateCandidateRow
  | SuggestionRow
  | ColumnRunRow
  | DiscoveryRow
  | AskCardsRow

export type InboxKind = InboxRow['kind']

/**
 * The tables a row comes from — what the header tabs and the counts split
 * by. A column run's group is suggestions, gathered; it is not a lane.
 */
export type InboxLane = 'suggestion' | 'duplicate_candidate'

/**
 * What the queue is narrowed to. Null or absent: not narrowed that way.
 * - `record`: only rows about that entity — its suggestion card, and every
 *   open pair it is either side of (the record rail's "Waiting" chips).
 * - `source` and `space`: Today's Review rows. `source` is a proposer id or
 *   `judgment`; `space` takes a discovery card by its payload and any other
 *   card by its record's earliest live filing, as `reviewGroupsProgram`
 *   counts them. Either one leaves the duplicate lane out.
 */
export type InboxScope = {
  record: string | null
  source?: string | null
  space?: string | null
  /** The reader: their own Ask threads' cards gather under each thread. */
  viewer?: string | null
}

const ALL: InboxScope = { record: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether Today's source or space filter narrows the queue. */
const filtered = (scope: InboxScope): boolean =>
  (scope.source ?? null) !== null || (scope.space ?? null) !== null

/** Cards whose record's earliest filing in a live space is `spaceId`. */
const firstFiledIn = (spaceId: string) => sql`${suggestion.entityId} in (
  select f.entity_id from (
    select distinct on (es.entity_id) es.entity_id, es.space_id
    from entity_space es
    join space s on s.entity_id = es.space_id
    join entity e on e.id = s.entity_id
    where s.archived_at is null and e.merged_into_id is null
    order by es.entity_id, es.created_at, es.space_id
  ) f
  where f.space_id = ${spaceId}::uuid
)`

const sourceIs = (source: string) =>
  source === JUDGMENT_REF
    ? ne(suggestion.proposedByType, 'integration')
    : and(
        eq(suggestion.proposedByType, 'integration'),
        eq(suggestion.proposedById, source),
      )

const spaceIs = (spaceId: string) =>
  or(
    and(
      inArray(suggestion.kind, [...DISCOVERY_KINDS]),
      sql`${suggestion.payload} ->> 'spaceId' = ${spaceId}`,
    ),
    and(
      notInArray(suggestion.kind, [...DISCOVERY_KINDS]),
      firstFiledIn(spaceId),
    ),
  )

const listDuplicateLane = Effect.fn('listDuplicateLane')(function* (
  scope: InboxScope,
): Effect.fn.Return<Array<DuplicateCandidateRow>, InboxQueryFailed> {
  // A pair has no source and no space: a Today row never names one.
  if (filtered(scope)) return []
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
): Effect.fn.Return<
  Array<SuggestionRow | ColumnRunRow | DiscoveryRow | AskCardsRow>,
  InboxQueryFailed
> {
  const isOpen = eq(suggestion.status, 'open')
  const source = scope.source ?? null
  const spaceId = scope.space ?? null
  const open = yield* query(() =>
    db
      .select()
      .from(suggestion)
      .where(
        and(
          isOpen,
          scope.record === null
            ? undefined
            : or(
                eq(suggestion.entityId, scope.record),
                and(
                  inArray(suggestion.kind, [...DISCOVERY_KINDS]),
                  sql`${suggestion.payload} ->> 'spaceId' = ${scope.record}`,
                ),
              ),
          source === null ? undefined : sourceIs(source),
          spaceId === null ? undefined : spaceIs(spaceId),
        ),
      )
      .orderBy(desc(suggestion.createdAt), desc(suggestion.id)),
  )
  if (open.length === 0) return []

  // A discovery card groups under its space, not the record it may name;
  // an `add_record` names none.
  const anchorOf = (s: (typeof open)[number]): string | null =>
    isDiscoveryKind(s.kind) ? discoverySpaceOf(s.payload) : s.entityId
  const entityIds = [
    ...new Set(
      open.flatMap((s) => {
        const anchor = anchorOf(s)
        return anchor === null ? [] : [anchor]
      }),
    ),
  ]
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
  // A document is the anchor of a captured page's read; its
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

  // An MCP proposal carries its API token's id as the integration
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
  // A discovery group's head names the plugins that found its cards.
  const integrationIds = [
    ...new Set(
      open.flatMap((s) =>
        isDiscoveryKind(s.kind) &&
        s.proposedByType === 'integration' &&
        s.proposedById !== null &&
        UUID.test(s.proposedById)
          ? [s.proposedById]
          : [],
      ),
    ),
  ]
  const integrationName = new Map(
    integrationIds.length === 0
      ? []
      : (yield* query(() =>
          db
            .select({
              id: integration.id,
              capabilityId: integration.capabilityId,
              manifest: integration.manifest,
            })
            .from(integration)
            .where(inArray(integration.id, integrationIds)),
        )).map((i) => [
          i.id,
          jsonString(jsonRecord(i.manifest).name) ?? i.capabilityId,
        ]),
  )
  const discoverySpaceIds = [
    ...new Set(
      open.flatMap((s) => {
        const id = isDiscoveryKind(s.kind) ? discoverySpaceOf(s.payload) : null
        return id === null ? [] : [id]
      }),
    ),
  ]
  const spacePath = new Map(
    discoverySpaceIds.length === 0
      ? []
      : (yield* query(() =>
          db.execute<{ id: string; path: string }>(sql`
            select s.entity_id as id,
              string_agg(e.canonical_name, ' / ' order by nlevel(a.path)) as path
            from space s
            join space a on a.path @> s.path
            join entity e on e.id = a.entity_id
            where s.entity_id in (${sql.join(
              discoverySpaceIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
            group by s.entity_id
          `),
        )).rows.map((r) => [r.id, r.path]),
  )

  const originOf = (s: (typeof open)[number]): SuggestionOrigin => {
    if (s.proposedByType !== 'integration') return { via: 'app' }
    const token =
      s.proposedById === null ? undefined : tokenName.get(s.proposedById)
    return token === undefined ? { via: 'integration' } : { via: 'mcp', token }
  }

  // A column run's suggestions gather under the run. The runs are
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
  // A capture read's run names the object its page was read as.
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

  // An Ask card names its suggestion from the answer's calls; only the
  // thread's author is shown the thread.
  const viewer = scope.viewer ?? null
  const askTurns =
    viewer === null || runIds.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              threadId: askThread.id,
              title: askThread.title,
              calls: askTurn.calls,
            })
            .from(askTurn)
            .innerJoin(askThread, eq(askThread.id, askTurn.threadId))
            .where(
              and(
                inArray(askTurn.aiRunId, runIds),
                eq(askThread.userId, viewer),
              ),
            ),
        )
  const threadOfCard = new Map<string, { id: string; title: string }>()
  for (const t of askTurns)
    for (const c of t.calls)
      if (c.card !== undefined)
        threadOfCard.set(c.card.suggestionId, {
          id: t.threadId,
          title: t.title,
        })
  const askGroups = new Map<string, Map<string, SuggestionRow>>()

  // `open` is newest first, so the first member seen for a record is its
  // newest and Map insertion order is already the queue's order.
  const cards = new Map<string, SuggestionRow>()
  const discoveries = new Map<string, DiscoveryRow>()
  for (const s of open) {
    const anchor = anchorOf(s)
    const head = anchor === null ? undefined : headOf.get(anchor)
    if (!head) continue
    if (isDiscoveryKind(s.kind)) {
      const item: SuggestionItem = {
        id: s.id,
        kind: s.kind,
        payload: s.payload,
        rationale: s.rationale,
        citations: citationsOf.get(s.id) ?? [],
        fields: null,
        origin: originOf(s),
        createdAt: s.createdAt.toISOString(),
        runId: s.runId,
      }
      const via =
        s.proposedById === null
          ? undefined
          : integrationName.get(s.proposedById)
      const group = discoveries.get(head.id)
      if (group) {
        group.suggestions.push(item)
        if (via !== undefined && !group.via.includes(via)) group.via.push(via)
      } else
        discoveries.set(head.id, {
          kind: 'discovery',
          id: head.id,
          space: {
            id: head.id,
            name: head.name,
            path: spacePath.get(head.id) ?? head.name,
          },
          via: via === undefined ? [] : [via],
          suggestions: [item],
          latestAt: item.createdAt,
        })
      continue
    }
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
    const inThread = threadOfCard.get(s.id)
    let into = cards
    if (inThread !== undefined) {
      const group =
        askGroups.get(inThread.id) ?? new Map<string, SuggestionRow>()
      askGroups.set(inThread.id, group)
      into = group
    } else if (inRun !== null) {
      const group = groups.get(inRun) ?? new Map<string, SuggestionRow>()
      groups.set(inRun, group)
      into = group
    }
    const page: CapturedPage | null =
      pageObjectId === null
        ? null
        : { title: head.name, url: pageUrl.get(head.id) ?? null }
    const card = into.get(head.id)
    if (card) {
      card.suggestions.push(item)
      card.page ??= page
    } else
      into.set(head.id, {
        kind: 'suggestion',
        id: head.id,
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
  const titleOf = new Map(
    [...threadOfCard.values()].map((t) => [t.id, t.title]),
  )
  const askRows = [...askGroups].flatMap(
    ([threadId, group]): Array<AskCardsRow> => {
      const members = [...group.values()]
      const newest = members.at(0)
      return newest === undefined
        ? []
        : [
            {
              kind: 'ask_cards',
              id: threadId,
              title: titleOf.get(threadId) ?? '',
              cards: members,
              latestAt: newest.latestAt,
            },
          ]
    },
  )
  return [...cards.values(), ...runRows, ...discoveries.values(), ...askRows]
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
 * The open sweep pairs `entityId` is either side of, read from its side —
 * the record notices band's "Possibly the same as" lines. The duplicate
 * lane's own query, so the band and Review never disagree.
 */
export const recordDuplicatesProgram = Effect.fn('recordDuplicatesProgram')(
  function* (
    entityId: string,
  ): Effect.fn.Return<Array<RecordDuplicate>, InboxQueryFailed> {
    const pairs = yield* listDuplicateLane({ record: entityId })
    return pairs.map((pair) => duplicateOf(pair, entityId))
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

/** Today's filter in words, for the header's chip; null for a name nothing answers. */
export type InboxFilterLabels = { source: string | null; space: string | null }

/** The names of a `source` and a `space` filter: the proposer and the space's path. */
export const inboxFilterLabelsProgram = Effect.fn('inboxFilterLabelsProgram')(
  function* (
    source: string | null,
    spaceId: string | null,
  ): Effect.fn.Return<InboxFilterLabels, InboxQueryFailed> {
    const sourceName =
      source === null
        ? null
        : source === JUDGMENT_REF
          ? JUDGMENT
          : !UUID.test(source)
            ? null
            : yield* query(async () => {
                const plugin = (
                  await db
                    .select({
                      capabilityId: integration.capabilityId,
                      manifest: integration.manifest,
                    })
                    .from(integration)
                    .where(eq(integration.id, source))
                ).at(0)
                if (plugin !== undefined)
                  return (
                    jsonString(jsonRecord(plugin.manifest).name) ??
                    plugin.capabilityId
                  )
                const token = (
                  await db
                    .select({ name: apiToken.name })
                    .from(apiToken)
                    .where(eq(apiToken.id, source))
                ).at(0)
                return token?.name ?? null
              })
    const spaceName =
      spaceId === null
        ? null
        : yield* query(async () => {
            const res = await db.execute<{ path: string | null }>(sql`
              select string_agg(e.canonical_name, ' / ' order by nlevel(a.path)) as path
              from space s
              join space a on a.path @> s.path
              join entity e on e.id = a.entity_id
              where s.entity_id = ${spaceId}::uuid
            `)
            return res.rows.at(0)?.path ?? null
          })
    return { source: sourceName, space: spaceName }
  },
)

/** One kind of open suggestion on one record, and how many are waiting. */
export type OpenSuggestionCount = { kind: SuggestionKind; count: number }

/** The enum's declared order — the order the rail draws its chips in. */
const KIND_ORDER: ReadonlyArray<SuggestionKind> = suggestionKind.enumValues

/**
 * The record rail's "Waiting" lane: open suggestions on one
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
