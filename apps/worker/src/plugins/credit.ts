import { Effect, Predicate } from 'effect'
import { and, eq, gte, max, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, integration } from '@spaces/db/schema'
import { capRefusal } from '@spaces/core/plugins/credit'
import { JobPermanent, JobRetryable } from '@spaces/sdk'
import type { CostHook, CostInput, Manifest } from '@spaces/sdk'
import { JobSkipped } from '../run-job'
import { messageOf } from './loader'

/**
 * Credit safety around an `action` job, in the host so no plugin can bypass
 * it (D53). Before the job runs:
 * - Cache: a receipt from this integration for the entity younger than
 *   `cacheDays` skips the job — no provider call.
 * - Cap: today's spend plus the job's `cost` estimate over `dailyCreditCap`
 *   refuses it; a job with no `cost` hook is refused once spend reaches the cap.
 * - Spend is only `sum(enrichment_record.credits_used)` for the integration
 *   since UTC midnight, so it survives a restart.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CACHE_DAYS = 90

/** The two settings the guard reads; a null cap means no cap. */
export type CreditPolicy = {
  readonly cacheDays: number
  readonly dailyCreditCap: number | null
}

const nonNegative = z.number().nonnegative()
const declaredSettings = z.object({
  properties: z.record(z.string(), z.object({ default: z.unknown() }).loose()),
})

const numberOr = <T>(value: unknown, fallback: T): number | T => {
  const parsed = nonNegative.safeParse(value)
  return parsed.success ? parsed.data : fallback
}

/** The manifest's declared defaults: `cacheDays` 90 and no cap when it declares none. */
export const creditDefaults = (manifest: Manifest): CreditPolicy => {
  const parsed = declaredSettings.safeParse(manifest.settings)
  const declared = parsed.success ? parsed.data.properties : {}
  const defaultOf = (key: string): unknown =>
    Object.hasOwn(declared, key) ? declared[key].default : undefined
  return {
    cacheDays: numberOr(defaultOf('cacheDays'), DEFAULT_CACHE_DAYS),
    dailyCreditCap: numberOr(defaultOf('dailyCreditCap'), null),
  }
}

/** `integration.config`'s `cacheDays` and `dailyCreditCap`, else the defaults. */
export const creditPolicy = (
  config: { readonly [key: string]: unknown },
  defaults: CreditPolicy,
): CreditPolicy => ({
  cacheDays: numberOr(config['cacheDays'], defaults.cacheDays),
  dailyCreditCap: numberOr(config['dailyCreditCap'], defaults.dailyCreditCap),
})

const costOutput = z.object({ credits: nonNegative })

/** A bundle's hook: what it returns is checked, so only callability is claimed. */
const isHook = (value: unknown): value is (input: CostInput) => unknown =>
  typeof value === 'function'

/** An action job export's `cost` hook, or null when it has none. */
export const costOf = (exported: unknown): CostHook | null => {
  if (!Predicate.hasProperty(exported, 'cost')) return null
  const hook = exported.cost
  return isHook(hook) ? (input) => costOutput.parse(hook(input)) : null
}

const unreadable = (what: string) => (error: unknown) =>
  new JobRetryable({ reason: `could not read ${what}: ${messageOf(error)}` })

/** UTC midnight today, as Postgres reckons it. */
const utcMidnight = sql`(date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')`

/** Credits this integration's receipts used since UTC midnight. */
export const spendToday = (
  integrationId: string,
): Effect.Effect<number, JobRetryable> =>
  Effect.tryPromise({
    try: () =>
      db
        .select({
          spent: sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
            Number,
          ),
        })
        .from(enrichmentRecord)
        .where(
          and(
            eq(enrichmentRecord.integrationId, integrationId),
            gte(enrichmentRecord.fetchedAt, utcMidnight),
          ),
        ),
    catch: unreadable("today's credit spend"),
  }).pipe(Effect.map((rows) => rows.at(0)?.spent ?? 0))

const lastEnrichedAt = (integrationId: string, entityId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ at: max(enrichmentRecord.fetchedAt) })
        .from(enrichmentRecord)
        .where(
          and(
            eq(enrichmentRecord.integrationId, integrationId),
            eq(enrichmentRecord.entityId, entityId),
          ),
        ),
    catch: unreadable('the latest receipt'),
  }).pipe(Effect.map((rows) => rows.at(0)?.at ?? null))

const configOf = (integrationId: string) =>
  Effect.tryPromise({
    try: () =>
      db
        .select({ config: integration.config })
        .from(integration)
        .where(eq(integration.id, integrationId)),
    catch: unreadable('the integration config'),
  }).pipe(Effect.map((rows) => rows.at(0)?.config ?? {}))

export type CreditGuard = {
  readonly integrationId: string
  readonly entityId: string
  readonly defaults: CreditPolicy
  readonly cost: CostHook | null
}

const daysAgo = (days: number) => `${days} day${days === 1 ? '' : 's'} ago`

/**
 * Passes, or fails `JobSkipped` with the reason the `job_run` row keeps.
 * The config is read per job, so a changed cap applies to the next one.
 */
export const guardAction = Effect.fn('guardAction')(function* (
  guard: CreditGuard,
): Effect.fn.Return<void, JobSkipped | JobRetryable | JobPermanent> {
  const policy = creditPolicy(
    yield* configOf(guard.integrationId),
    guard.defaults,
  )

  const last = yield* lastEnrichedAt(guard.integrationId, guard.entityId)
  if (last !== null) {
    const age = Date.now() - last.getTime()
    if (age < policy.cacheDays * DAY_MS) {
      return yield* new JobSkipped({
        reason: `cached (enriched ${daysAgo(Math.floor(age / DAY_MS))})`,
      })
    }
  }

  const cap = policy.dailyCreditCap
  if (cap === null) return
  const spent = yield* spendToday(guard.integrationId)
  const refused = capRefusal(cap)
  if (guard.cost === null) {
    if (spent >= cap) return yield* new JobSkipped({ reason: refused })
    return
  }
  const hook = guard.cost
  const estimate = yield* Effect.try({
    try: () => hook({ entityIds: [guard.entityId] }).credits,
    catch: (error) =>
      new JobPermanent({
        reason: `the cost hook did not return { credits }: ${messageOf(error)}`,
      }),
  })
  if (spent + estimate > cap) return yield* new JobSkipped({ reason: refused })
})
