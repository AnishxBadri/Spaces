import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireAdmin, requireSettingsReader, requireUser } from './shared'
import { input } from './input'

export type {
  AutoEnrichView as EnrichmentAutoView,
  EnrichmentPage,
  EnrichmentSource,
  FillsWhat,
  GridAttribute,
  RecentRun,
} from '../integrations/enrichment-page'
export type {
  LastRun,
  RecordEnrichment,
} from '../integrations/enrichment-record'

const uuid = Schema.String.check(Schema.isUUID())
export type { GridCell, WhereFrom } from '@spaces/core/enrichment/page'

/**
 * Settings → Integrations → Enrichment and a record's enrichment. Reads are any member's; every write opens with `requireAdmin()`.
 * The programs are imported inside the handlers so their database code
 * never reaches the client bundle.
 */

/** The Enrichment page: sources in order, auto-enrich, the grid, recent runs. */
export const getEnrichmentPage = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { enrichmentPageProgram } =
    await import('../integrations/enrichment-page')
  const { effectFn } = await import('./effect')
  return effectFn(enrichmentPageProgram)()
})

/** The sources on, in the order a run asks them; a source left out is off. */
export const saveEnrichmentOrder = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({ ids: Schema.Array(uuid).check(Schema.isMaxLength(50)) }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const { saveSourceOrderProgram } =
      await import('../integrations/enrichment-page')
    const { effectFn } = await import('./effect')
    return effectFn(saveSourceOrderProgram)(data.ids)
  })

/** The paid sources' auto-enrich scope. */
export const saveEnrichmentAuto = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        scopes: Schema.Array(
          Schema.Literals(['deal', 'space', 'meeting']),
        ).check(Schema.isMaxLength(3)),
        spaces: Schema.Array(uuid).check(Schema.isMaxLength(500)),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const { saveAutoEnrichProgram } =
      await import('../integrations/enrichment-page')
    const { effectFn } = await import('./effect')
    return effectFn(saveAutoEnrichProgram)({
      scopes: data.scopes,
      spaces: data.spaces,
    })
  })

/** How many days a source's answer is reused before it is asked again. */
export const saveEnrichmentReuse = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        days: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3650 })),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const { saveReuseDaysProgram } =
      await import('../integrations/enrichment-page')
    const { effectFn } = await import('./effect')
    return effectFn(saveReuseDaysProgram)(data.days)
  })

/** A record's Enrich line and the where-from of each filled value. */
export const getRecordEnrichment = createServerFn()
  .validator(
    input(
      Schema.Struct({
        entityId: uuid,
        kind: Schema.Literals(['company', 'person']),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const u = await requireUser()
    const { recordEnrichmentProgram } =
      await import('../integrations/enrichment-record')
    const { setupAudienceProgram } =
      await import('../integrations/setup-status')
    const { effectFn } = await import('./effect')
    const [enrichment, audience] = await Promise.all([
      effectFn(recordEnrichmentProgram)(data.entityId, data.kind),
      effectFn(setupAudienceProgram)(u.role ?? 'member'),
    ])
    return { ...enrichment, audience, kind: data.kind }
  })
