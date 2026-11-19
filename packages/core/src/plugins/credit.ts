import { Option, Schema } from 'effect'
import type { Manifest } from '@spaces/sdk'
import { finite } from '../attributes/registry'
import { plainRecord } from '../json'

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

const nonNegative = Schema.decodeUnknownOption(
  Schema.Number.check(finite, Schema.isGreaterThanOrEqualTo(0)),
)

/**
 * The settings' JSON Schema properties. `default` is a required key: one
 * property that declares no default leaves every setting undeclared.
 */
const declaredSettings = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: plainRecord(Schema.Struct({ default: Schema.Unknown })),
  }),
)

const numberOr = <T>(value: unknown, fallback: T): number | T =>
  Option.getOrElse(nonNegative(value), (): number | T => fallback)

/** The manifest's declared defaults: `cacheDays` 90 and no cap when it declares none. */
export const creditDefaults = (manifest: Manifest): CreditPolicy => {
  const declared = Option.match(declaredSettings(manifest.settings), {
    onNone: (): {
      readonly [key: string]: { readonly default: unknown }
    } => ({}),
    onSome: (settings) => settings.properties,
  })
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
