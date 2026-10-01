import { Effect, Schema } from 'effect'
import { asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import {
  aiRun,
  aiUsage,
  entity,
  integration,
  objectDef,
  suggestion,
  user,
} from '@spaces/db/schema'
import type {
  AiRunStatus,
  actorType,
  suggestionKind,
  suggestionStatus,
} from '@spaces/db/schema'
import { resolveRefsProgram } from '@spaces/core/writes/context/names'
import type { ResolvedRef } from '@spaces/core/writes/context/names'
import { effectFn } from '#/lib/server/effect'
import { requireUser } from '#/lib/server/shared'
import type { AiLane } from './lanes'
import { suggestionOfOutputRef } from './run'

/**
 * Settings → Usage (SPA-100): the run log read back. `ai_usage` has been
 * written since the first Test call (ai-4a); this is its surface, listed by
 * run — task, record, who, when, status, tokens, what the run proposed — and,
 * opened, each step's tool, model, tokens and `input_refs → output_ref`, the
 * refs resolved to names by `resolveRefsProgram` (`@spaces/core/writes/context/names`,
 * which renders through `cite.ts`). Calls no run owns — the settings Test
 * call — are listed apart, under "Calls outside a run".
 *
 * Read by any signed-in member: it is provenance, the page the inbox's
 * "produced by this run" opens, and it writes nothing. The refs it resolves
 * are the ones the inbox already resolves for the same reader.
 */

export const RUNS_LISTED = 100
export const LONE_CALLS_LISTED = 50

export class UsageQueryFailed extends Schema.TaggedError<UsageQueryFailed>()(
  'UsageQueryFailed',
  { cause: Schema.Defect() },
) {}

const query = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new UsageQueryFailed({ cause }),
  })

type ActorType = (typeof actorType.enumValues)[number]
type SuggestionKind = (typeof suggestionKind.enumValues)[number]
type SuggestionStatus = (typeof suggestionStatus.enumValues)[number]

export type RunRecord = {
  id: string
  name: string
  kind: string
  objectSlug: string | null
}

export type RunListItem = {
  id: string
  task: string
  record: RunRecord | null
  /** A person's name, an integration's capability, or `system`. */
  who: string
  status: AiRunStatus
  error: string | null
  startedAt: string
  finishedAt: string | null
  tokensIn: number | null
  tokensOut: number | null
  steps: number
  suggestions: { open: number; accepted: number; rejected: number }
}

export type LoneCall = {
  id: string
  lane: AiLane
  provider: string
  model: string
  tokensIn: number | null
  tokensOut: number | null
  who: string
  at: string
}

export type UsageView = {
  runs: Array<RunListItem>
  loneCalls: Array<LoneCall>
}

export type RunStepView = {
  tool: AiLane
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  cached: boolean
  at: string
  jobRunId: string | null
  inputs: Array<ResolvedRef>
  output: RunOutput | null
}

export type RunOutput =
  | {
      kind: 'suggestion'
      ref: string
      suggestionKind: SuggestionKind
      status: SuggestionStatus
      record: string
    }
  | { kind: 'ref'; ref: string; resolved: ResolvedRef }
  /** An output ref whose row is gone. */
  | { kind: 'missing'; ref: string }

export type RunSuggestion = {
  id: string
  kind: SuggestionKind
  status: SuggestionStatus
  record: RunRecord
}

export type RunDetail = {
  run: RunListItem
  credentialId: string | null
  steps: Array<RunStepView>
  suggestions: Array<RunSuggestion>
  /** How many `ai_usage` rows cite the run — one per step that called. */
  calls: number
}

/** Names for a set of typed actors, one query per kind. */
const whoNames = Effect.fn('usage.whoNames')(function* (
  actors: ReadonlyArray<{ type: ActorType; id: string | null }>,
): Effect.fn.Return<
  (type: ActorType, id: string | null) => string,
  UsageQueryFailed
> {
  const userIds = [
    ...new Set(
      actors.flatMap((a) => (a.type === 'user' && a.id ? [a.id] : [])),
    ),
  ]
  const integrationIds = [
    ...new Set(
      actors.flatMap((a) => (a.type === 'integration' && a.id ? [a.id] : [])),
    ),
  ]
  const users =
    userIds.length === 0
      ? []
      : yield* query(() =>
          db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, userIds)),
        )
  // An integration id is a uuid; anything else in the column names no row.
  const uuids = integrationIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const integrations =
    uuids.length === 0
      ? []
      : yield* query(() =>
          db
            .select({ id: integration.id, name: integration.capabilityId })
            .from(integration)
            .where(inArray(integration.id, uuids)),
        )
  const names = new Map([...users, ...integrations].map((r) => [r.id, r.name]))
  return (type, id) =>
    type === 'system'
      ? 'system'
      : ((id === null ? undefined : names.get(id)) ??
        (type === 'user' ? 'a former member' : 'an integration'))
})

const recordsOf = (ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed(new Map<string, RunRecord>())
    : query(async () => {
        const rows = await db
          .select({
            id: entity.id,
            name: entity.canonicalName,
            kind: entity.kind,
            objectSlug: objectDef.slug,
          })
          .from(entity)
          .leftJoin(objectDef, eq(objectDef.id, entity.objectId))
          .where(inArray(entity.id, [...ids]))
        return new Map(rows.map((r) => [r.id, r]))
      })

type RunRow = typeof aiRun.$inferSelect

const listItems = Effect.fn('usage.listItems')(function* (
  rows: ReadonlyArray<RunRow>,
): Effect.fn.Return<Array<RunListItem>, UsageQueryFailed> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const counts = yield* query(() =>
    db
      .select({
        runId: suggestion.runId,
        status: suggestion.status,
        n: sql<number>`count(*)::int`,
      })
      .from(suggestion)
      .where(inArray(suggestion.runId, ids))
      .groupBy(suggestion.runId, suggestion.status),
  )
  const records = yield* recordsOf([
    ...new Set(rows.flatMap((r) => (r.entityId === null ? [] : [r.entityId]))),
  ])
  const who = yield* whoNames(
    rows.map((r) => ({ type: r.startedByType, id: r.startedById })),
  )
  return rows.map((r) => {
    const tally = { open: 0, accepted: 0, rejected: 0 }
    for (const c of counts) if (c.runId === r.id) tally[c.status] += c.n
    return {
      id: r.id,
      task: r.task,
      record: r.entityId === null ? null : (records.get(r.entityId) ?? null),
      who: who(r.startedByType, r.startedById),
      status: r.status,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      steps: r.steps.length,
      suggestions: tally,
    }
  })
})

export const usageViewProgram = Effect.fn('usageView')(
  function* (): Effect.fn.Return<UsageView, UsageQueryFailed> {
    const rows = yield* query(() =>
      db
        .select()
        .from(aiRun)
        .orderBy(desc(aiRun.startedAt), desc(aiRun.id))
        .limit(RUNS_LISTED),
    )
    const runs = yield* listItems(rows)
    const lone = yield* query(() =>
      db
        .select()
        .from(aiUsage)
        .where(isNull(aiUsage.runId))
        .orderBy(desc(aiUsage.at), desc(aiUsage.id))
        .limit(LONE_CALLS_LISTED),
    )
    const who = yield* whoNames(
      lone.map((u) => ({ type: u.callerType, id: u.callerId })),
    )
    return {
      runs,
      loneCalls: lone.map((u) => ({
        id: u.id,
        lane: u.lane,
        provider: u.provider,
        model: u.model,
        tokensIn: u.tokensIn,
        tokensOut: u.tokensOut,
        who: who(u.callerType, u.callerId),
        at: u.at.toISOString(),
      })),
    }
  },
)

export const runDetailProgram = Effect.fn('runDetail')(function* (
  runId: string,
): Effect.fn.Return<RunDetail | null, UsageQueryFailed> {
  const row = (yield* query(() =>
    db.select().from(aiRun).where(eq(aiRun.id, runId)),
  )).at(0)
  if (!row) return null
  const run = (yield* listItems([row])).at(0)
  if (!run) return null

  const produced = yield* query(() =>
    db
      .select({
        id: suggestion.id,
        kind: suggestion.kind,
        status: suggestion.status,
        entityId: suggestion.entityId,
      })
      .from(suggestion)
      .where(eq(suggestion.runId, runId))
      .orderBy(asc(suggestion.createdAt), asc(suggestion.id)),
  )
  // A step's output may name a suggestion of another run only by corruption;
  // it is looked up by id all the same, so the label never lies.
  const outputIds = row.steps.flatMap((s) => {
    const id =
      s.output_ref === null ? null : suggestionOfOutputRef(s.output_ref)
    return id === null ? [] : [id]
  })
  const extra = outputIds.filter((id) => !produced.some((p) => p.id === id))
  const others =
    extra.length === 0
      ? []
      : yield* query(() =>
          db
            .select({
              id: suggestion.id,
              kind: suggestion.kind,
              status: suggestion.status,
              entityId: suggestion.entityId,
            })
            .from(suggestion)
            .where(inArray(suggestion.id, extra)),
        )
  const bySuggestion = new Map([...produced, ...others].map((s) => [s.id, s]))
  const records = yield* recordsOf([
    ...new Set([...bySuggestion.values()].map((s) => s.entityId)),
  ])

  // Every input ref and every non-suggestion output, in one resolve.
  const contextRefs = row.steps.flatMap((s) => [
    ...s.input_refs,
    ...(s.output_ref !== null && suggestionOfOutputRef(s.output_ref) === null
      ? [s.output_ref]
      : []),
  ])
  const resolved = yield* resolveRefsProgram(contextRefs).pipe(
    Effect.mapError((cause) => new UsageQueryFailed({ cause })),
  )
  const labelOf = new Map(resolved.map((r) => [r.ref, r]))
  const resolve = (ref: string): ResolvedRef =>
    labelOf.get(ref) ?? { ref, entityId: null, label: ref, missing: false }

  const outputOf = (ref: string | null): RunOutput | null => {
    if (ref === null) return null
    const id = suggestionOfOutputRef(ref)
    if (id === null) return { kind: 'ref', ref, resolved: resolve(ref) }
    const s = bySuggestion.get(id)
    if (!s) return { kind: 'missing', ref }
    return {
      kind: 'suggestion',
      ref,
      suggestionKind: s.kind,
      status: s.status,
      record: records.get(s.entityId)?.name ?? 'a record no longer here',
    }
  }

  const calls = (yield* query(() =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiUsage)
      .where(eq(aiUsage.runId, runId)),
  )).at(0)

  return {
    run,
    credentialId: row.credentialId,
    steps: row.steps.map((s) => ({
      tool: s.tool,
      model: s.model,
      tokensIn: s.tokens_in,
      tokensOut: s.tokens_out,
      cached: s.cached === true,
      at: s.at,
      jobRunId: s.job_run_id,
      inputs: s.input_refs.map(resolve),
      output: outputOf(s.output_ref),
    })),
    suggestions: produced.flatMap((s) => {
      const record = records.get(s.entityId)
      return record
        ? [{ id: s.id, kind: s.kind, status: s.status, record }]
        : []
    }),
    calls: calls?.n ?? 0,
  }
})

export async function getAiUsageHandler(): Promise<UsageView> {
  await requireUser()
  return effectFn(usageViewProgram)()
}

export async function getAiRunHandler(
  runId: string,
): Promise<RunDetail | null> {
  await requireUser()
  return effectFn(runDetailProgram)(runId)
}
