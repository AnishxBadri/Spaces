import type { ConfirmOptions } from '#/components/ui/confirm-dialog'
import { formatNumber } from '@spaces/core/format'
import type { BackfillEstimate } from '#/lib/ai/providers/embed/ids'

/**
 * The backfill's ask (SPA-136) — the one place embedding waits for a yes.
 * Kept out of the tsx so the promise it makes can be tested without a DOM:
 * the estimate is on the sheet before anything runs, and cancelling makes
 * no call at all. The estimate itself came from `getEmbedBackfill`, which
 * reads the database and the queue and never a provider.
 */

export function backfillConfirmOptions(
  estimate: BackfillEstimate,
  model: string,
): ConfirmOptions {
  return {
    title: `Backfill ${formatNumber(estimate.chunks, 0)} ${estimate.chunks === 1 ? 'chunk' : 'chunks'}?`,
    body: `Embeds every chunk not yet on ${model}, in batches. The day's AI cap stops it where it is, and it resumes after 00:00 UTC. Nothing is sent until you confirm.`,
    rows: [
      { name: 'Chunks', meta: formatNumber(estimate.chunks, 0) },
      {
        name: 'Tokens, estimated',
        meta: `~${formatNumber(estimate.tokens, 0)}`,
      },
      { name: 'Cost, at list price', meta: estimate.cost },
    ],
    action: 'Backfill',
    keep: 'Cancel',
    kind: 'primary',
  }
}

/** Ask with the estimate; start only on a yes. A cancel answers null and calls nothing. */
export async function confirmThenStart<T>(
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  options: ConfirmOptions,
  start: () => Promise<T>,
): Promise<T | null> {
  if (!(await confirm(options))) return null
  return start()
}
