import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAdmin, requireSettingsReader, requireUser } from './shared'

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
export type { GridCell, WhereFrom } from '@spaces/core/enrichment/page'

/**
 * Settings → Integrations → Enrichment and a record's enrichment (D76,
 * D81). Reads are any member's; every write opens with `requireAdmin()`.
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
  .validator(z.object({ ids: z.array(z.uuid()).max(50) }))
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
    z.object({
      scopes: z.array(z.enum(['deal', 'space', 'meeting'])).max(3),
      spaces: z.array(z.uuid()).max(500),
    }),
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
  .validator(z.object({ days: z.int().min(0).max(3650) }))
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
    z.object({ entityId: z.uuid(), kind: z.enum(['company', 'person']) }),
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
