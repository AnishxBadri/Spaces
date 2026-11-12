import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { BULK_MAX } from '@spaces/core/enrichment/estimate'
import { requireUser } from './shared'
import { pagedListShape } from '#/lib/views/page-input'
import { input } from './input'

/**
 * Bulk Enrich from a list: the estimate window's read and its Enrich n.
 * - `target` is the selection bar's checked ids, or the list's view (its
 *   conditions and text box) for the `···` menu — at most `BULK_MAX`.
 * - The estimate spends nothing; `bulkEnrich` recomputes it before it sends.
 */

const bulkInput = Schema.Struct({
  kind: Schema.Literals(['company', 'person']),
  target: Schema.Union([
    Schema.Struct({
      ids: Schema.mutable(
        Schema.Array(Schema.String.check(Schema.isUUID())),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(BULK_MAX)),
    }),
    Schema.Struct({
      conditions: pagedListShape.conditions,
      q: pagedListShape.q,
    }),
  ]),
})
type BulkInput = typeof bulkInput.Type

/** The records a target names: the ids given, or the view's first `BULK_MAX`. */
async function idsOf(data: BulkInput) {
  if ('ids' in data.target)
    return { ids: data.target.ids, total: data.target.ids.length }
  const { listIdsProgram } = await import('../views/directory')
  const { effectFn } = await import('./effect')
  return effectFn(listIdsProgram)(
    data.kind,
    data.target.conditions ?? [],
    data.target.q ?? '',
    BULK_MAX,
  )
}

/** What Enrich would ask, skip and spend, per source. Any member; a read. */
export const estimateBulkEnrich = createServerFn()
  .validator(input(bulkInput))
  .handler(async ({ data }) => {
    await requireUser()
    const { ids, total } = await idsOf(data)
    const { bulkEstimateProgram } =
      await import('@spaces/core/writes/enrichment/estimate')
    const { effectFn } = await import('./effect')
    const e = await effectFn(bulkEstimateProgram)(data.kind, ids)
    // The plan stays on the server: Enrich n recomputes it.
    return {
      total: e.total,
      ask: e.ask,
      parks: e.parks,
      skipped: e.skipped,
      sources: e.sources,
      reuseDays: e.reuseDays,
      /** Records the target named before `BULK_MAX` cut it. */
      matched: total,
    }
  })

/** Enrich n: one `enrichment.run` per record asked, parked past a cap. */
export const bulkEnrich = createServerFn({ method: 'POST' })
  .validator(input(bulkInput))
  .handler(async ({ data }) => {
    await requireUser()
    const { ids } = await idsOf(data)
    const { Effect } = await import('effect')
    const { bulkEnrichProgram } =
      await import('@spaces/core/writes/enrichment/estimate')
    const { webEnqueue } = await import('../enqueue-live')
    return Effect.runPromise(
      bulkEnrichProgram(data.kind, ids).pipe(Effect.provide(webEnqueue)),
    )
  })
