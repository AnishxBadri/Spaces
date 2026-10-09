import { Context } from 'effect'
import type { Effect } from 'effect'
import type { JobError } from '@spaces/sdk'

/**
 * How an enrichment run asks one source (D76): run its enrich action for a
 * record, with the vocabulary keys still wanted. The source answers through
 * `Facts.answer`, which the run collects (`EnrichmentCollector`).
 * - `asked: false` with the reason when the host declined before any call:
 *   not loaded, no action for the kind, a reusable receipt, the credit cap.
 * - The worker's Live runs the plugin's job in process; tests hand fixtures.
 */

export type AskInput = {
  readonly entityId: string
  readonly kind: 'company' | 'person'
  readonly keys: ReadonlyArray<string>
  /** The owner's reuse window; null leaves the source's own `cacheDays`. */
  readonly reuseDays: number | null
}

export type AskResult =
  { readonly asked: true } | { readonly asked: false; readonly reason: string }

export class EnrichmentSources extends Context.Service<
  EnrichmentSources,
  {
    readonly ask: (
      integrationId: string,
      input: AskInput,
    ) => Effect.Effect<AskResult, JobError>
  }
>()('spaces/core/EnrichmentSources') {}
