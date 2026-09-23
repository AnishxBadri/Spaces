/**
 * The AI spend cap (SPA-73, D46 Option 1) — tokens per workspace per UTC
 * day, counted from `ai_usage`. One pure predicate that every model call
 * consults before it spends: `complete()` today, `embed()` when ai-9a lands
 * it. The window is "since UTC midnight of `now`", so the day turns over at
 * 00:00 UTC for every operator whatever their timezone, and `resetsAt` is
 * always the next UTC midnight.
 *
 * This is **not** sdk-16's enrichment credit cap, and the two are kept apart
 * on purpose. That one counts a provider's *credits* per *integration*, read
 * from `enrichment_record`, and is enforced in the worker before an
 * enrichment job calls out (CONTEXT.md, "Credit safety"); this one counts
 * model *tokens* per *workspace*, read from `ai_usage`. Different units
 * (a credit is whatever the vendor bills; a token is the model's), different
 * ledgers, different scopes — a merged counter would have to convert one
 * into the other, and there is no honest rate. Two counters, two homes;
 * neither reimplements the other.
 */

import type { AiCapsSetting } from '@spaces/db/schema/workspace'

/** The settings shape, camel-cased. Absent means no cap on that axis. */
export type AiCaps = {
  /** Tokens (in + out) the workspace may spend per UTC day. */
  dailyTokens?: number
  /** The largest estimated prompt one call may send. */
  perRunTokens?: number
}

/**
 * `workspace.settings.ai_caps` read cautiously: a ceiling is a positive
 * whole number or it is no ceiling. The bag is jsonb, so a hand-edited `0`,
 * a negative or a string is read as absent rather than as "refuse
 * everything".
 */
export function capsFromSettings(stored: AiCapsSetting | undefined): AiCaps {
  const ceiling = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0
  const daily = stored?.daily_tokens
  const perRun = stored?.per_run_tokens
  const caps: AiCaps = {}
  if (ceiling(daily)) caps.dailyTokens = daily
  if (ceiling(perRun)) caps.perRunTokens = perRun
  return caps
}

/**
 * One `ai_usage` row — or an aggregate of a day's rows, stamped with the
 * start of the window it sums, which is what `complete()` hands in.
 */
export type CapUsage = {
  at: Date
  tokensIn: number | null
  tokensOut: number | null
}

export type CapVerdict =
  | { ok: true }
  | {
      ok: false
      kind: 'daily'
      ceiling: number
      /** Tokens spent since UTC midnight. */
      used: number
      /** The next UTC midnight, ISO. */
      resetsAt: string
    }
  | {
      ok: false
      kind: 'per_run'
      ceiling: number
      /** This call's estimate. */
      used: number
      resetsAt: null
    }

/** 00:00 UTC of `now`'s UTC day. */
export function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
}

/** 00:00 UTC of the day after `now`'s — when the daily cap resets. */
export function nextUtcMidnight(now: Date): Date {
  const start = utcDayStart(now)
  return new Date(start.getTime() + 24 * 60 * 60 * 1000)
}

/**
 * A call's token estimate before it is made: characters ÷ 4, rounded up —
 * the usual English-text rule of thumb for BPE tokenizers. It is taken from
 * the call's `budgetChars` (the rendered prompt's ceiling, task included),
 * not the rendered prompt, so the check needs nothing but the options and
 * over-estimates rather than under.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

/** Tokens in + out spent in `now`'s UTC day. A null count is zero. */
export function tokensToday(usage: ReadonlyArray<CapUsage>, now: Date): number {
  const start = utcDayStart(now).getTime()
  const end = nextUtcMidnight(now).getTime()
  let used = 0
  for (const row of usage) {
    const t = row.at.getTime()
    if (t < start || t >= end) continue
    used += (row.tokensIn ?? 0) + (row.tokensOut ?? 0)
  }
  return used
}

/**
 * May a call go ahead? The daily cap refuses once the day's tokens are
 * **at** the ceiling; below it, a call runs even if it will carry the day
 * over — the check is per call, before it, never mid-stream. The per-run cap
 * refuses a call whose estimate alone is over it. The daily verdict is
 * checked first: a day that is spent is the answer whatever the call's size.
 */
export function capVerdict(input: {
  usage: ReadonlyArray<CapUsage>
  caps: AiCaps
  now: Date
  /** This call's estimate (`estimateTokens`); omitted skips the per-run cap. */
  estimate?: number
}): CapVerdict {
  const { caps, now } = input
  if (caps.dailyTokens !== undefined) {
    const used = tokensToday(input.usage, now)
    if (used >= caps.dailyTokens)
      return {
        ok: false,
        kind: 'daily',
        ceiling: caps.dailyTokens,
        used,
        resetsAt: nextUtcMidnight(now).toISOString(),
      }
  }
  if (
    caps.perRunTokens !== undefined &&
    input.estimate !== undefined &&
    input.estimate > caps.perRunTokens
  )
    return {
      ok: false,
      kind: 'per_run',
      ceiling: caps.perRunTokens,
      used: input.estimate,
      resetsAt: null,
    }
  return { ok: true }
}
