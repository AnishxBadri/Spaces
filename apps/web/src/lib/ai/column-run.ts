import { Effect, Schema } from 'effect'
import { and, desc, eq, exists, inArray, not, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { LanguageModel } from 'ai'
import { db } from '@spaces/db'
import {
  aiUsage,
  attribute,
  entity,
  objectDef,
  suggestion,
  view,
} from '@spaces/db/schema'
import { readAiConfig } from '@spaces/core/ai/attribute-ai'
import type { AiAttributeConfig } from '@spaces/core/ai/attribute-ai'
import { QUEUES } from '@spaces/core/queue/names'
import { enqueue, jobsByKey } from '#/lib/queue'
import type { QueuedJob } from '#/lib/queue'
import { compileViewWhere, scopeOf, viewLensProgram } from '#/lib/views/counts'
import { listScope } from '#/lib/views/scope'
import type { ListScope } from '#/lib/views/scope'
import {
  afterCursor,
  cutPage,
  decodeCursor,
  orderByPage,
  planSort,
  sortKeyColumn,
} from '#/lib/views/paging'
import type { PageCursor } from '#/lib/views/paging'
import { attributeRunMessage, attributeRunProgram } from './attribute-run'
import type { AttributeRunFailure } from './attribute-run'
import { capMessage } from './caps'
import { completeMessage, laneTargetProgram } from './complete'
import { closeRunProgram, openRunProgram } from './run'
import type { RunWriteFailed } from './run'

/**
 * Column run (SPA-122; docs/spec-ai-substrate.md §13, "bulk = job with
 * estimate + per-day cap"). One AI-configured attribute over every record a
 * saved view names, as one worker job — the per-cell program
 * (`./attribute-run.ts`) once per row, never a fork of it.
 *
 * **The view's rows, server-side.** The set is `listScope` plus the view's
 * stored conditions compiled by `compileConditions` — the `where` the list
 * page filters by and the chip counts over (`views/counts.ts`), never the
 * rows on screen and never the object's total. Every slug is resolved before
 * compiling: a view whose conditions the compiler cannot express (an
 * archived or unknown attribute) is **refused**, at the estimate, at the
 * press and again in the job, rather than run over a partial `where` that
 * names more records than the view does.
 *
 * **Skipped, not re-proposed.** A row that already carries an open
 * `attribute_patch` naming the attribute — a value or a registry proposal,
 * the same test the cell's "proposed" state reads (`suggestionNames`) — is
 * outside the walk: the estimate subtracts it and the page query excludes
 * it, so a second run over the same view proposes only what is missing.
 *
 * **A page at a time.** The walk is the list pages' keyset pager
 * (`views/paging.ts`) over entity ids — oldest first, `COLUMN_RUN_PAGE` rows
 * per query — so the job never holds the view, and a record born mid-run
 * cannot shift a row out of the walk.
 *
 * **One run, one step per row.** The job opens one `ai_run`; every row's
 * cell threads it (`runId`), so each lane call is one step whose
 * `output_ref` is the suggestion it wrote, and every suggestion carries the
 * run's id — which is how /inbox groups them under one header
 * (`isColumnRunTask`) with "Accept all".
 *
 * **The daily cap stops it.** `complete()` refuses a call once the day's
 * tokens reach the workspace ceiling (`./caps.ts`); the run catches that
 * refusal, proposes nothing more, and closes `failed` with the summary —
 * rows done and rows left — in `ai_run.error`, which is where the inbox's
 * run header and Settings → Usage read it. A run that walks to the end
 * closes `done`. A row that fails on its own (a sensitive record on a cloud
 * route, a record merged mid-run, a provider error on that one call) is
 * counted and the walk goes on; a failure that would fail every row (no
 * route, no key, the run log unwritable) stops it like the cap does.
 */

/** Rows per page of the walk. */
export const COLUMN_RUN_PAGE = 50

/** What the Usage page lists a column run as, before its attribute and view. */
export const COLUMN_RUN_TASK = 'Column run'

export const columnRunTask = (attributeName: string, viewName: string) =>
  `${COLUMN_RUN_TASK} · ${attributeName} · ${viewName}`

/** Is this `ai_run.task` a column run's — the inbox's grouping test. */
export const isColumnRunTask = (task: string): boolean =>
  task.startsWith(`${COLUMN_RUN_TASK} · `)

export const columnRunKey = (viewId: string, attributeId: string) =>
  `${viewId}:${attributeId}`

export class ColumnRunRefused extends Schema.TaggedError<ColumnRunRefused>()(
  'ColumnRunRefused',
  { message: Schema.String },
) {}

export class ColumnRunQueryFailed extends Schema.TaggedError<ColumnRunQueryFailed>()(
  'ColumnRunQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ColumnRunQueryFailed({ cause }),
  })

const refuse = (message: string) => new ColumnRunRefused({ message })

// ---------- the target: one saved view, one AI attribute ----------

type Target = {
  view: { id: string; name: string }
  attribute: {
    id: string
    name: string
    slug: string
    ai: AiAttributeConfig
  }
  scope: ListScope
  /** `listScope` and the view's compiled conditions: the rows it names. */
  where: SQL
}

const readTarget = Effect.fn('columnRun.target')(function* (
  viewId: string,
  attributeId: string,
  userId: string,
): Effect.fn.Return<Target, ColumnRunRefused | ColumnRunQueryFailed> {
  // The visibility `listViewsProgram` applies: shared, or the caller's own.
  const saved = (yield* query(() =>
    db
      .select({
        id: view.id,
        name: view.name,
        objectId: view.objectId,
        filter: view.filter,
      })
      .from(view)
      .where(
        and(
          eq(view.id, viewId),
          or(eq(view.visibility, 'shared'), eq(view.createdBy, userId)),
        ),
      ),
  )).at(0)
  if (!saved) return yield* refuse('That view is gone')
  if (saved.objectId === null)
    return yield* refuse('A column run needs a view of an object’s records')
  const objectId = saved.objectId
  const object = (yield* query(() =>
    db
      .select({ id: objectDef.id, slug: objectDef.slug })
      .from(objectDef)
      .where(eq(objectDef.id, objectId)),
  )).at(0)
  if (!object) return yield* refuse('That view’s list is gone')
  const attr = (yield* query(() =>
    db
      .select({
        id: attribute.id,
        name: attribute.name,
        slug: attribute.slug,
        type: attribute.type,
        options: attribute.options,
        objectId: attribute.objectId,
        archived: attribute.archived,
      })
      .from(attribute)
      .where(eq(attribute.id, attributeId)),
  )).at(0)
  if (!attr || attr.archived || attr.objectId !== objectId)
    return yield* refuse('That attribute is not on this list')
  const ai = readAiConfig(attr)
  if (ai === null) return yield* refuse(`${attr.name} is not an AI attribute`)

  const lens = yield* viewLensProgram(objectId).pipe(
    Effect.mapError((e) => new ColumnRunQueryFailed({ cause: e.cause })),
  )
  const compiled = compileViewWhere(saved.filter, lens)
  if ('lost' in compiled)
    return yield* refuse(
      `“${saved.name}” filters on “${compiled.lost}”, which ${compiled.archived ? 'is archived' : 'this list no longer has'}; a run would cover more records than the view names, so it is refused. Edit the view first.`,
    )
  const scope = scopeOf(object)
  return {
    view: { id: saved.id, name: saved.name },
    attribute: { id: attr.id, name: attr.name, slug: attr.slug, ai },
    scope,
    where: and(listScope(scope), compiled.where) ?? listScope(scope),
  }
})

/** `[a-z0-9_]` in practice; escaped anyway, since it is spliced into a regex. */
const regexLiteral = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * An open `attribute_patch` on the row naming `slug` — as a value, or as a
 * registry proposal (the `optionProposalLine` grammar of
 * `@spaces/core/ai/attribute-ai`, read newline-sensitively). The SQL twin
 * of `suggestionNames`, so the walk and the cell agree on "proposed".
 */
export function openProposalFor(slug: string): SQL {
  const proposal = `(?n)^Proposed new option ".*" for .+ \\(${regexLiteral(slug)}\\)\\.$`
  return exists(
    db
      .select({ one: sql`1` })
      .from(suggestion)
      .where(
        and(
          eq(suggestion.entityId, entity.id),
          eq(suggestion.status, 'open'),
          eq(suggestion.kind, 'attribute_patch'),
          or(
            sql`jsonb_exists(${suggestion.payload}, ${slug})`,
            sql`coalesce(${suggestion.rationale} ~ ${proposal}, false)`,
          ),
        ),
      ),
  )
}

// ---------- the estimate ----------

export type ColumnRunEstimate =
  | {
      ok: true
      viewName: string
      attributeName: string
      /** `count(*)` over the view's conditions — what its chip shows. */
      total: number
      /** Of those, rows with an open proposal for the attribute already. */
      proposed: number
      /** `total - proposed`: one lane call each. */
      calls: number
      /**
       * Tokens one call spent last time — this attribute's last run on this
       * list, else the lane's last call; null when neither has happened.
       */
      perCall: { tokens: number; from: 'attribute' | 'lane' } | null
      /** `calls × perCall`; null when `perCall` is. */
      tokens: number | null
    }
  | { ok: false; reason: string }

const usageTokens = (
  rows: ReadonlyArray<{ tokensIn: number | null; tokensOut: number | null }>,
): number | null => {
  const r = rows.at(0)
  if (!r || (r.tokensIn === null && r.tokensOut === null)) return null
  return (r.tokensIn ?? 0) + (r.tokensOut ?? 0)
}

/**
 * The rough cost of one row: the tokens of the newest lane call whose run
 * proposed this attribute on this list (a per-cell press, or an earlier
 * column run's row), else of the lane's newest call of any kind.
 */
const perCallProgram = Effect.fn('columnRun.perCall')(function* (
  target: Target,
): Effect.fn.Return<
  { tokens: number; from: 'attribute' | 'lane' } | null,
  ColumnRunQueryFailed
> {
  const lane = eq(aiUsage.lane, target.attribute.ai.lane)
  const runs = db
    .select({ runId: suggestion.runId })
    .from(suggestion)
    .innerJoin(entity, eq(entity.id, suggestion.entityId))
    .where(
      and(
        eq(suggestion.kind, 'attribute_patch'),
        sql`jsonb_exists(${suggestion.payload}, ${target.attribute.slug})`,
        listScope(target.scope),
      ),
    )
  const own = usageTokens(
    yield* query(() =>
      db
        .select({ tokensIn: aiUsage.tokensIn, tokensOut: aiUsage.tokensOut })
        .from(aiUsage)
        .where(and(lane, inArray(aiUsage.runId, runs)))
        .orderBy(desc(aiUsage.at))
        .limit(1),
    ),
  )
  if (own !== null) return { tokens: own, from: 'attribute' }
  const any = usageTokens(
    yield* query(() =>
      db
        .select({ tokensIn: aiUsage.tokensIn, tokensOut: aiUsage.tokensOut })
        .from(aiUsage)
        .where(lane)
        .orderBy(desc(aiUsage.at))
        .limit(1),
    ),
  )
  return any === null ? null : { tokens: any, from: 'lane' }
})

const countProgram = Effect.fn('columnRun.count')(function* (target: Target) {
  const row = (yield* query(() =>
    db
      .select({
        total: sql<number>`count(*)::int`,
        proposed: sql<number>`(count(*) filter (where ${openProposalFor(target.attribute.slug)}))::int`,
      })
      .from(entity)
      .where(target.where),
  )).at(0)
  const total = row?.total ?? 0
  const proposed = row?.proposed ?? 0
  return { total, proposed, calls: Math.max(0, total - proposed) }
})

/**
 * What the confirm dialog shows before anything is queued. Every refusal —
 * a view gone, an attribute with no AI config, a condition the compiler
 * cannot express — is `ok: false` with its sentence, so the dialog says
 * why instead of showing a number.
 */
export const estimateColumnRunProgram = Effect.fn('estimateColumnRun')(
  function* (
    viewId: string,
    attributeId: string,
    userId: string,
  ): Effect.fn.Return<ColumnRunEstimate, ColumnRunQueryFailed> {
    const target = yield* Effect.result(readTarget(viewId, attributeId, userId))
    if (target._tag === 'Failure') {
      if (target.failure._tag === 'ColumnRunRefused')
        return { ok: false, reason: target.failure.message }
      return yield* target.failure
    }
    const t = target.success
    const counted = yield* countProgram(t)
    const perCall = yield* perCallProgram(t)
    return {
      ok: true,
      viewName: t.view.name,
      attributeName: t.attribute.name,
      ...counted,
      perCall,
      tokens: perCall === null ? null : perCall.tokens * counted.calls,
    }
  },
)

// ---------- the run (worker) ----------

export type ColumnRunInput = {
  viewId: string
  attributeId: string
  /** Who pressed "Run on this view" — every row's caller and proposer. */
  userId: string
  /** The test seam: an injected model replaces the vault lookup. */
  model?: LanguageModel
  /** Rows per page; `COLUMN_RUN_PAGE` by default. */
  pageSize?: number
}

export type ColumnRunResult = {
  /** The run's `ai_run` id; null when there was nothing to run. */
  runId: string | null
  /** Rows the model was asked about. */
  done: number
  /** Suggestions written — a value, plus any registry proposal. */
  proposed: number
  /** Rows that failed on their own, each with why. */
  failed: Array<string>
  /** Rows the run did not reach, when it stopped early. */
  left: number
  /** Why the run stopped before the end; null when it walked the view. */
  stopped: string | null
  /** Page queries made — the walk's grain, never the whole view. */
  pages: number
}

/**
 * Failures that belong to one row: the walk counts them and goes on. Every
 * other failure — the cap, an unrouted lane, a missing key, an unwritable
 * run log or suggestion table — would fail the next row the same way, so it
 * stops the run.
 */
const rowLocal = (f: AttributeRunFailure): boolean =>
  f._tag === 'AttributeRunRefused' ||
  f._tag === 'SensitiveRouteRefused' ||
  f._tag === 'SensitivityEntityNotFound' ||
  f._tag === 'ProviderCallFailed' ||
  f._tag === 'SuggestionInvalid' ||
  f._tag === 'EntityNotFound'

/** The line `ai_run.error` carries for a run that stopped early. */
export const columnRunStopLine = (
  why: string,
  done: number,
  left: number,
): string =>
  `${why}. Stopped with ${String(done)} row${done === 1 ? '' : 's'} done, ${String(left)} left.`

export const columnRunProgram = Effect.fn('columnRun')(function* (
  input: ColumnRunInput,
): Effect.fn.Return<
  ColumnRunResult,
  ColumnRunRefused | ColumnRunQueryFailed | RunWriteFailed
> {
  const target = yield* readTarget(
    input.viewId,
    input.attributeId,
    input.userId,
  )
  const { calls } = yield* countProgram(target)
  if (calls === 0)
    return {
      runId: null,
      done: 0,
      proposed: 0,
      failed: [],
      left: 0,
      stopped: null,
      pages: 0,
    }

  const runId = yield* openRunProgram({
    task: columnRunTask(target.attribute.name, target.view.name),
    entityId: null,
    startedBy: { type: 'user', id: input.userId },
  })

  // Oldest first, keyset on (created_at, id) — the list pages' own pager.
  const plan = planSort({ id: 'createdAt', desc: false }, () => null)
  const pageSize = Math.max(1, input.pageSize ?? COLUMN_RUN_PAGE)
  const pending = and(target.where, not(openProposalFor(target.attribute.slug)))
  let cursor: PageCursor | null = null
  let done = 0
  let proposed = 0
  let pages = 0
  const failed: Array<string> = []
  let stopped: string | null = null

  walk: for (;;) {
    const at = cursor
    const page = yield* query(() =>
      db
        .select({
          id: entity.id,
          name: entity.canonicalName,
          sortKey: sortKeyColumn(plan),
        })
        .from(entity)
        .where(at === null ? pending : and(pending, afterCursor(plan, at)))
        .orderBy(orderByPage(plan))
        .limit(pageSize + 1),
    ).pipe(
      Effect.tapError(() =>
        closeRunProgram(runId, {
          status: 'failed',
          error: 'Could not read the view’s records',
        }).pipe(Effect.ignore),
      ),
    )
    pages += 1
    const { rows, nextCursor } = cutPage(page, pageSize)
    for (const row of rows) {
      const cell = yield* Effect.result(
        attributeRunProgram({
          entityId: row.id,
          attributeId: target.attribute.id,
          userId: input.userId,
          runId,
          ...(input.model === undefined ? {} : { model: input.model }),
        }),
      )
      if (cell._tag === 'Success') {
        done += 1
        proposed += cell.success.suggestions.length
        continue
      }
      const f = cell.failure
      if (f._tag === 'CapExceeded') {
        stopped = capMessage(f)
        break walk
      }
      if (!rowLocal(f)) {
        stopped = attributeRunMessage(f)
        break walk
      }
      failed.push(`${row.name}: ${attributeRunMessage(f)}`)
    }
    if (nextCursor === null) break
    cursor = decodeCursor(nextCursor)
    if (cursor === null) break
  }

  const left = stopped === null ? 0 : Math.max(0, calls - done - failed.length)
  yield* closeRunProgram(
    runId,
    stopped === null
      ? { status: 'done' }
      : { status: 'failed', error: columnRunStopLine(stopped, done, left) },
  )
  return { runId, done, proposed, failed, left, stopped, pages }
})

// ---------- the press ----------

export type ColumnRunEnqueued =
  | { status: 'queued'; calls: number }
  | { status: 'already-running' }
  | { status: 'queue-unavailable' }
  | { status: 'refused'; message: string }

const inFlight = (j: QueuedJob): boolean =>
  j.state === 'created' || j.state === 'retry' || j.state === 'active'

/**
 * "Run on this view", confirmed: the estimate again (the view may have
 * changed since the dialog opened, and a refused view is refused here too),
 * the lane's route checked at normal sensitivity, then one job keyed on
 * (view, attribute). Every refusal comes back as a sentence.
 */
export const pressColumnRunProgram = Effect.fn('pressColumnRun')(function* (
  viewId: string,
  attributeId: string,
  userId: string,
): Effect.fn.Return<ColumnRunEnqueued> {
  const refused = (message: string): ColumnRunEnqueued => ({
    status: 'refused',
    message,
  })
  return yield* Effect.gen(function* () {
    const target = yield* readTarget(viewId, attributeId, userId)
    const { calls } = yield* countProgram(target)
    if (calls === 0)
      return refused(
        `Every record in “${target.view.name}” already has a ${target.attribute.name} proposal waiting, or the view is empty`,
      )
    yield* laneTargetProgram(target.attribute.ai.lane, {
      sensitivity: 'normal',
    })
    const key = columnRunKey(target.view.id, target.attribute.id)
    const jobId = yield* query(() =>
      enqueue(
        QUEUES.attributeColumnRun,
        { viewId: target.view.id, attributeId: target.attribute.id, userId },
        { singletonKey: key },
      ),
    )
    if (jobId !== null) return { status: 'queued', calls } as const
    const jobs = yield* query(() => jobsByKey(QUEUES.attributeColumnRun, key))
    return jobs !== null && jobs.some(inFlight)
      ? ({ status: 'already-running' } as const)
      : ({ status: 'queue-unavailable' } as const)
  }).pipe(
    Effect.catch((failure) =>
      Effect.succeed(
        refused(
          failure._tag === 'ColumnRunRefused'
            ? failure.message
            : failure._tag === 'ColumnRunQueryFailed'
              ? 'Could not read the view or its records'
              : completeMessage(failure),
        ),
      ),
    ),
  )
})
