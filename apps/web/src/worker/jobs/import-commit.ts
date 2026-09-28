import { Effect } from 'effect'
import { z } from 'zod'
import { commitRunLine, runLinePrefix } from '@spaces/core/import/commit'
import { QUEUES } from '@spaces/core/queue/names'
import { commitImportProgram, commitMessage } from '#/lib/import/commit'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * `import.commit` (SPA-169, import-7) — a planned batch's rows through their
 * creators, each row in its own transaction (`#/lib/import/commit`); a
 * ledger batch's rows through the portfolio write path (SPA-171,
 * `#/lib/import/ledger-commit`). The
 * program never fails on a row — a row's failure is its own `error` — so
 * the job fails only when the batch itself cannot commit (not planned, a
 * collision undecided, a query that broke), and then permanently: the
 * operator re-runs it, and a re-run writes nothing for a row that landed.
 *
 * Its `job_run.summary` is the run's line, led by the batch id —
 * `batch <id> · 46 written · 0 attached · 0 failed · 0 unchanged` — which is
 * how the batch page finds its own last run on a ledger with no batch
 * column; a refusal carries the same prefix in `job_run.error`.
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
