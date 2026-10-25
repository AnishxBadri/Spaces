import type { DiscoveryEvidence } from '@spaces/core/ai/discovery'
import type { JobStatusState } from '#/lib/integrations/job-status-view'

/**
 * What a discovery card reads as in Review, pure so the card and its tests
 * share it.
 */

/** "found by 2 watches"; null for one watch or none — the head says via. */
export function foundByLine(watches: number): string | null {
  return watches >= 2 ? `found by ${String(watches)} watches` : null
}

/** An evidence chip's words: its title, else the page's host. */
export function evidenceLabel(e: DiscoveryEvidence): string {
  if (e.title !== undefined) return e.title
  try {
    return new URL(e.url).host.replace(/^www\./, '')
  } catch {
    return e.url
  }
}

/** Where an accepted "add X?" card stands while `entity.created` fans out. */
export type AfterState =
  | 'enriching'
  | 'enriched'
  | 'enrich-failed'
  /** Added, and no enrichment ran: nothing was installed to run one. */
  | 'added'
  /** Accepted a company already held, or a `file_record`: filed, nothing born. */
  | 'filed'

export const AFTER_WORDS: Record<AfterState, string> = {
  enriching: 'Added · enriching',
  enriched: 'Added · enriched',
  'enrich-failed': 'Added · enrichment failed',
  added: 'Added',
  filed: 'Filed here',
}

/**
 * The new record's jobs, read off its status stream: enriching while any
 * runs, or while none has shown up and the stream is not yet `quiet`.
 */
export function enrichPhase(
  state: JobStatusState,
  quiet: boolean,
): Exclude<AfterState, 'filed'> {
  const rows = [...state.rows.values()]
  if (rows.some((r) => r.status === 'running')) return 'enriching'
  if (rows.length === 0) return quiet ? 'added' : 'enriching'
  return rows.some((r) => r.status === 'failed') ? 'enrich-failed' : 'enriched'
}

/** Whether the after-state is final: the card may leave the queue. */
export const settled = (after: AfterState): boolean => after !== 'enriching'
