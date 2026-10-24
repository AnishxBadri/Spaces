import { z } from 'zod'
import type { Manifest } from '@spaces/sdk'

/**
 * A source's credit policy: how long its receipt is reused and its
 * daily cap. The plugin host's guard and the host's auto-enrich checks read
 * it the same way.
 */

/**
 * The words a credit-cap refusal is written in, shared by the worker that
 * writes it to `job_run.summary` and the Today line that reads it back.
 * A cache skip is the other `skipped` reason and never starts with these.
 */
export const CAP_REFUSAL_PREFIX = 'daily credit cap'

export const capRefusal = (cap: number): string =>
  `${CAP_REFUSAL_PREFIX} (${cap}) reached`

/** Whether a skip reason is a credit-cap refusal rather than a cache skip. */
export const isCapRefusal = (reason: string): boolean =>
  reason.startsWith(CAP_REFUSAL_PREFIX)

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
