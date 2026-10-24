import { Effect } from 'effect'
import { z } from 'zod'
import { commitRunLine, runLinePrefix } from '@spaces/core/import/commit'
import { QUEUES } from '@spaces/core/queue/names'
import { commitImportProgram, commitMessage } from '#web/lib/import/commit'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * import.commit: commits a planned batch, each row in its own transaction
 * through its creator, or a ledger batch through the portfolio write path.
 * - A row's failure is its own `error`; the job fails only when the batch
 *   cannot commit (not planned, collision undecided, a broken query), and
 *   then permanently. A re-run writes nothing for a row that landed.
 * - `job_run.summary` leads with `batch <id> · …`, which is how the batch page
 *   finds its last run on a ledger with no batch column; a refusal carries
 *   the same prefix in `job_run.error`.
 */

export const importCommitData = z.object({
  batchId: z.string().uuid(),
  userId: z.string().min(1),
  onlyFailed: z.boolean(),
})

export type ImportCommitData = z.infer<typeof importCommitData>

/** A 20,000-row sheet is minutes of work; pg-boss's default expiry is 15. */
export const IMPORT_COMMIT_EXPIRE_SECONDS = 4 * 60 * 60

export const importCommit: JobDef<ImportCommitData> = {
  name: QUEUES.importCommit,
  schema: importCommitData,
  run: (data) =>
    commitImportProgram(data).pipe(
      Effect.map((run) => commitRunLine(data.batchId, run)),
      Effect.catch(
        (failure) =>
          new JobPermanent({
            reason: `${runLinePrefix(data.batchId)}${commitMessage(failure)}`,
          }),
      ),
    ),
}
