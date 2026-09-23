import { Clock, Effect, Schema } from 'effect'
import { eq, gte, sql } from 'drizzle-orm'
import { db } from '@spaces/db'
import { aiUsage, workspace } from '@spaces/db/schema'
import type { AiCapsSetting } from '@spaces/db/schema/workspace'
import {
  capVerdict,
  capsFromSettings,
  estimateTokens,
  nextUtcMidnight,
  utcDayStart,
} from '@spaces/core/ai/caps'
import type { AiCaps, CapUsage } from '@spaces/core/ai/caps'
import { formatNumber } from '@spaces/core/format'
import { effectFn } from '#/lib/server/effect'
import { requireAdmin } from '#/lib/server/shared'
import type { AiCapsInput } from './caps-input'

/**
 * The AI cap's database half (SPA-73). `@spaces/core/ai/caps` is the pure
 * predicate — tokens per workspace per UTC day, read from `ai_usage` — and
 * this module reads its two inputs (the caps from `workspace.settings.ai_caps`,
 * today's usage as one aggregate) and holds the admin fns behind
 * Settings → AI · Caps.
 *
 * This is the workspace **token** cap. sdk-16's enrichment **credit** cap is
 * the other counter — per integration, from `enrichment_record`, enforced in
 * the worker — and the two are not merged: different units, ledgers and
 * scopes (the reasoning is on `@spaces/core/ai/caps`).
 */

/** A call refused by the cap, before any provider was called. */
export class CapExceeded extends Schema.TaggedError<CapExceeded>()(
  'CapExceeded',
  {
    kind: Schema.Literals(['daily', 'per_run']),
    ceiling: Schema.Number,
    used: Schema.Number,
    /** The next UTC midnight, ISO; null for the per-run cap, which never resets. */
    resetsAt: Schema.NullOr(Schema.String),
  },
) {}

export class CapReadFailed extends Schema.TaggedError<CapReadFailed>()(
  'CapReadFailed',
  { cause: Schema.Defect() },
) {}

export class CapWriteFailed extends Schema.TaggedError<CapWriteFailed>()(
  'CapWriteFailed',
  { message: Schema.String, cause: Schema.Defect() },
) {}

const read = <T>(f: () => Promise<T>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new CapReadFailed({ cause }) })

const count = (n: number) => formatNumber(n, 0)

/** The sentence a refusal is shown as — `completeMessage` delegates here. */
export function capMessage(e: CapExceeded): string {
  if (e.kind === 'per_run')
    return `This call's estimated ${count(e.used)} tokens is over the per-run AI cap of ${count(e.ceiling)}`
  return `Today's AI cap of ${count(e.ceiling)} tokens is reached; resets at 00:00 UTC`
}

const readSettings = read(() =>
  db
    .select({ settings: workspace.settings })
    .from(workspace)
    .where(eq(workspace.id, 1)),
).pipe(Effect.map((rows) => rows.at(0)?.settings ?? {}))

export const readAiCapsProgram = Effect.fn('readAiCaps')(
  function* (): Effect.fn.Return<AiCaps, CapReadFailed> {
    const settings = yield* readSettings
    return capsFromSettings(settings.ai_caps)
  },
)

/**
 * Today's `ai_usage` as one aggregate row, stamped with the window's start —
 * one `SUM` over the `ai_usage_at_idx` range rather than a day of rows.
 */
export const usageTodayProgram = Effect.fn('usageToday')(function* (
  now: Date,
): Effect.fn.Return<CapUsage, CapReadFailed> {
  const start = utcDayStart(now)
  const rows = yield* read(() =>
    db
      .select({
        tokensIn: sql<number>`coalesce(sum(${aiUsage.tokensIn}), 0)`.mapWith(
          Number,
        ),
        tokensOut: sql<number>`coalesce(sum(${aiUsage.tokensOut}), 0)`.mapWith(
          Number,
        ),
      })
      .from(aiUsage)
      .where(gte(aiUsage.at, start)),
  )
  const row = rows.at(0)
  return {
    at: start,
    tokensIn: row?.tokensIn ?? 0,
    tokensOut: row?.tokensOut ?? 0,
  }
})

/**
 * The check every model call makes before it spends (`complete()` today,
 * `embed()` when ai-9a lands it). No cap configured → it reads nothing more
 * and never refuses. It is per call and made **before** the call: a call that
 * starts under the ceiling runs to completion and its `ai_usage` row is
 * written even if it carries the day over — the cap is never enforced
 * mid-stream, so the day can overshoot by at most the calls in flight.
 */
export const checkCapProgram = Effect.fn('checkCap')(function* (
  budgetChars: number,
): Effect.fn.Return<void, CapExceeded | CapReadFailed> {
  const caps = yield* readAiCapsProgram()
  if (caps.dailyTokens === undefined && caps.perRunTokens === undefined) return
  const now = new Date(yield* Clock.currentTimeMillis)
  const usage =
    caps.dailyTokens === undefined ? [] : [yield* usageTodayProgram(now)]
  const verdict = capVerdict({
    usage,
    caps,
    now,
    estimate: estimateTokens(budgetChars),
  })
  if (!verdict.ok)
    return yield* new CapExceeded({
      kind: verdict.kind,
      ceiling: verdict.ceiling,
      used: verdict.used,
      resetsAt: verdict.resetsAt,
    })
})

export type AiCapsView = {
  dailyTokens: number | null
  perRunTokens: number | null
}

export type AiUsageToday = {
  /** Tokens in + out since 00:00 UTC. */
  used: number
  /** 00:00 UTC today, ISO. */
  since: string
  /** 00:00 UTC tomorrow, ISO. */
  resetsAt: string
}

export const setAiCapsProgram = Effect.fn('setAiCaps')(function* (
  data: AiCapsInput,
): Effect.fn.Return<AiCapsView, CapWriteFailed | CapReadFailed> {
  const settings = yield* readSettings
  const aiCaps: AiCapsSetting = {}
  if (data.dailyTokens !== null) aiCaps.daily_tokens = data.dailyTokens
  if (data.perRunTokens !== null) aiCaps.per_run_tokens = data.perRunTokens
  // Both blank removes the key: "no cap" is the key's absence, not `{}`.
  const rest = Object.fromEntries(
    Object.entries(settings).filter(([k]) => k !== 'ai_caps'),
  )
  const next =
    Object.keys(aiCaps).length === 0 ? rest : { ...rest, ai_caps: aiCaps }
  const written = yield* Effect.tryPromise({
    try: () =>
      db
        .update(workspace)
        .set({ settings: next, updatedAt: new Date() })
        .where(eq(workspace.id, 1))
        .returning({ id: workspace.id }),
    catch: (cause) =>
      new CapWriteFailed({ message: 'Could not save the AI caps', cause }),
  })
  // First-run setup creates the singleton; a cap saved before it would
  // otherwise vanish into an update that matched nothing.
  if (written.length === 0)
    return yield* new CapWriteFailed({
      message: 'The workspace is not set up yet',
      cause: null,
    })
  return { dailyTokens: data.dailyTokens, perRunTokens: data.perRunTokens }
})

// The server fns' bodies. `requireAdmin()` first, always.

export async function getAiCapsHandler(): Promise<AiCapsView> {
  await requireAdmin()
  const caps = await effectFn(readAiCapsProgram)()
  return {
    dailyTokens: caps.dailyTokens ?? null,
    perRunTokens: caps.perRunTokens ?? null,
  }
}

export async function setAiCapsHandler(data: AiCapsInput): Promise<AiCapsView> {
  await requireAdmin()
  return effectFn(setAiCapsProgram)(data)
}

export async function getAiUsageTodayHandler(): Promise<AiUsageToday> {
  await requireAdmin()
  const now = new Date()
  const usage = await effectFn(usageTodayProgram)(now)
  return {
    used: (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0),
    since: utcDayStart(now).toISOString(),
    resetsAt: nextUtcMidnight(now).toISOString(),
  }
}
