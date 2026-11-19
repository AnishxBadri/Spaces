import { Schema } from 'effect'
import { DOMAIN_EVENTS } from '@spaces/sdk'
import type { DomainEventName } from '@spaces/sdk'
import { CORE_IDENTITY, uuidString } from '../attributes/registry'
import { DEFAULT_CACHE_DAYS } from '@spaces/core/plugins/credit'

/**
 * Auto-enrich is the Enrich button pressed for the owner: a trigger
 * queues `enrichment.run` only past the host's checks, in this order.
 * - `scope`: some source has the trigger in its auto-enrich scope;
 * - `sensitive`: a sensitive record keeps only local sources;
 * - `reuse`: no source answered for it within `reuseDays`;
 * - `key`: it has something to look up by, else `identity.added` retries it;
 * - `queued`: one job per record, by pg-boss's singleton key;
 * - `credits`: a source at its daily cap parks the run until 00:00 UTC.
 */

export const AUTO_ENRICH_CHECKS = [
  'scope',
  'sensitive',
  'reuse',
  'key',
  'queued',
  'credits',
] as const
export type AutoEnrichCheck = (typeof AUTO_ENRICH_CHECKS)[number]

/** The reuse window when the owner has set none: a source's default `cacheDays`. */
export const DEFAULT_REUSE_DAYS = DEFAULT_CACHE_DAYS

/** What one trigger came to. Only `credits` never stops a run: it parks it. */
export type AutoEnrichOutcome =
  | {
      readonly outcome: 'queued'
      readonly jobId: string
      readonly sources: ReadonlyArray<string>
    }
  | {
      readonly outcome: 'parked'
      readonly jobId: string
      readonly sources: ReadonlyArray<string>
      /** The source whose cap was reached. */
      readonly parkedBy: string
      readonly startAfter: Date
    }
  | {
      readonly outcome: 'skipped'
      readonly check: Exclude<AutoEnrichCheck, 'credits'>
    }

/** `enrichment.run`'s payload: the Enrich button sends the first two only. */
export const enrichmentRunData = Schema.Struct({
  entityId: uuidString,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  /** Ask only these sources; absent asks every source in the owner's order. */
  sources: Schema.optional(
    Schema.mutable(Schema.Array(uuidString)).check(Schema.isMinLength(1)),
  ),
  /** The domain event that queued it: an auto run, which parks at a cap. */
  trigger: Schema.optional(Schema.Literals(DOMAIN_EVENTS)),
  /** Set on a parked run: the source whose daily cap it waits out. */
  parkedBy: Schema.optional(uuidString),
  /** Sent from a list's Enrich…: parks at a cap like an auto run. */
  bulk: Schema.optional(Schema.Literal(true)),
})
export type EnrichmentRunData = typeof enrichmentRunData.Type

/** The reason an auto run is logged with. */
export const autoReason = (trigger: DomainEventName): string =>
  `Auto-enrich · ${trigger}`

const filled = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some((v) => typeof v === 'string' && v.trim() !== '')
    : typeof value === 'string' && value.trim() !== ''

/**
 * Whether a source has something to look the record up by: a company's
 * domain; a person's email or LinkedIn URL.
 */
export const hasLookupKey = (
  kind: 'company' | 'person',
  values: { readonly [slug: string]: unknown },
): boolean =>
  filled(values[CORE_IDENTITY[kind].slug]) ||
  (kind === 'person' && filled(values['linkedin']))
