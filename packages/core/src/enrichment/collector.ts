import { Context } from 'effect'
import type { Json } from '@spaces/db/json'

/**
 * Where `Facts.answer` puts a source's answers while an enrichment run asks
 * it: the run provides one per (source, record) around the ask, and the
 * port collects instead of writing, so the run applies every source's
 * answers at once (one card, one timeline line). Absent — the source's own
 * button, an event job — the port applies its answers as a run of one.
 */

export type CollectedAnswer = {
  readonly receiptId: string
  readonly asOf: string
  readonly answers: { readonly [key: string]: Json }
}

export type Collector = {
  readonly integrationId: string
  readonly entityId: string
  readonly answers: Array<CollectedAnswer>
}

export const EnrichmentCollector = Context.Reference<Collector | null>(
  'spaces/core/EnrichmentCollector',
  { defaultValue: () => null },
)
