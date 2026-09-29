import { Effect } from 'effect'
import { z } from 'zod'
import { QUEUES } from '@spaces/core/queue/names'
import { columnRunProgram } from '#web/lib/ai/column-run'
import type { ColumnRunInput } from '#web/lib/ai/column-run'
import { JobPermanent } from '../run-job'
import type { JobDef } from '../run-job'

/**
 * attribute.column-run — one AI attribute over one saved view (SPA-122).
 * The program is `lib/ai/column-run.ts`; this is the wrapper's view of it.
 * Enqueued by "Run on this view" in a list's column header, nothing else.
 *
 * **Never retried**, and a refusal is permanent: a view the compiler cannot
 * express, an attribute with no AI config or an unrouted lane is not fixed
 * by pg-boss trying again, and a retry would re-spend on every row the
 * first attempt had not reached. A run the daily cap stopped is not a job
 * failure either: it completes, its `ai_run` closed `failed` with rows done
 * and left, and pressing again after the reset proposes only what is still
 * missing.
 */

/**
 * How long one run may stay active before pg-boss expires it. The default
 * 15 minutes is a deck read's budget; a column run is one lane call per row
 * of a view, so it is given hours rather than being failed mid-walk.
 */
export const COLUMN_RUN_EXPIRE_SECONDS = 4 * 60 * 60

export const attributeColumnRunData = z.object({
  viewId: z.string().uuid(),
  attributeId: z.string().uuid(),
  userId: z.string().min(1),
})

export type AttributeColumnRunData = z.infer<typeof attributeColumnRunData>

/** The job's body, with the seams the test uses. */
export const runAttributeColumnRun = (
  data: AttributeColumnRunData,
  seam: Pick<ColumnRunInput, 'model' | 'pageSize'> = {},
) =>
  columnRunProgram({ ...data, ...seam }).pipe(
    Effect.tap((r) =>
      Effect.sync(() => {
        console.log(
          `[worker] column run ${data.viewId}/${data.attributeId}: ${String(r.done)} row(s), ${String(r.proposed)} suggestion(s), ${String(r.failed.length)} failed${r.stopped === null ? '' : `, stopped with ${String(r.left)} left: ${r.stopped}`}`,
        )
      }),
    ),
    Effect.asVoid,
    Effect.catch(
      (failure) =>
        new JobPermanent({
          reason:
            failure._tag === 'ColumnRunRefused'
              ? failure.message
              : failure._tag === 'RunWriteFailed'
                ? 'Could not record the AI run'
                : 'Could not read the view or its records',
        }),
    ),
  )

export const attributeColumnRun: JobDef<AttributeColumnRunData> = {
  name: QUEUES.attributeColumnRun,
  schema: attributeColumnRunData,
  retry: { limit: 0, delaySeconds: 0, backoff: false },
  run: (data) => runAttributeColumnRun(data),
}
