import { Clock, Effect, Predicate } from 'effect'
import { and, eq, max } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@spaces/db'
import { enrichmentRecord, integration } from '@spaces/db/schema'
import { utcDayStart } from '@spaces/core/ai/caps'
import {
  DEFAULT_CACHE_DAYS,
  capRefusal,
  creditDefaults,
  creditPolicy,
} from '@spaces/core/plugins/credit'
import type { CreditPolicy } from '@spaces/core/plugins/credit'
import { spendSince } from '@spaces/core/writes/enrichment/credits'
import { JobPermanent, JobRetryable } from '@spaces/sdk'
import type { CostHook, CostInput } from '@spaces/sdk'
import { JobSkipped } from '../run-job'
import { messageOf } from './loader'

/**
 * Credit safety around an `action` job, in the host so no plugin can bypass
 * it. Before the job runs:
 * - Cache: a receipt from this integration for the entity younger than
 *   `cacheDays` skips the job — no provider call.
 * - Cap: today's spend plus the job's `cost` estimate over `dailyCreditCap`
 *   refuses it; a job with no `cost` hook is refused once spend reaches the cap.
 * - Spend is only `sum(enrichment_record.credits_used)` for the integration
 *   since UTC midnight (`spendSince`), so it survives a restart.
 */

const DAY_MS = 24 * 60 * 60 * 1000
export { DEFAULT_CACHE_DAYS, creditDefaults, creditPolicy }
export type { CreditPolicy }

const nonNegative = z.number().nonnegative()

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

/** Credits this integration's receipts used since UTC midnight, by Effect's `Clock`. */
export const spendToday = (
  integrationId: string,
): Effect.Effect<number, JobRetryable> =>
  Effect.gen(function* () {
    const since = utcDayStart(new Date(yield* Clock.currentTimeMillis))
    return yield* Effect.tryPromise({
      try: () => spendSince(integrationId, since),
      catch: unreadable("today's credit spend"),
    })
  })

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
  /** The workspace's reuse window, over the integration's `cacheDays`. */
  readonly cacheDays?: number
}

const daysAgo = (days: number) => `${days} day${days === 1 ? '' : 's'} ago`

/**
 * Passes, or fails `JobSkipped` with the reason the `job_run` row keeps.
 * The config is read per job, so a changed cap applies to the next one.
 */
export const guardAction = Effect.fn('guardAction')(function* (
  guard: CreditGuard,
): Effect.fn.Return<void, JobSkipped | JobRetryable | JobPermanent> {
  const configured = creditPolicy(
    yield* configOf(guard.integrationId),
    guard.defaults,
  )
  const policy =
    guard.cacheDays === undefined
      ? configured
      : { ...configured, cacheDays: guard.cacheDays }

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
