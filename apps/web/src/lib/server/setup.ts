import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireAdmin, requireSettingsReader, requireUser } from './shared'

export type { DemoSummary } from '../seeds/demo'
export type { SetupAudience } from '../integrations/setup-status'

/**
 * The first run without a checklist: What's set up and the demo's
 * removal on General, and Enrich pressed on a record.
 * Programs are imported inside the handlers so their database code never
 * reaches the client bundle.
 */

/** General's foot: whether each of the seven pieces is set up. */
export const getWhatsSetUp = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { whatsSetUpProgram } = await import('../integrations/setup-status')
  const { effectFn } = await import('./effect')
  return effectFn(whatsSetUpProgram)()
})

/** The demo still recorded, by kind; null once removed or never loaded. */
export const getDemoSummary = createServerFn().handler(async () => {
  await requireSettingsReader()
  const { demoSummaryProgram } = await import('../seeds/demo')
  const { effectFn } = await import('./effect')
  return effectFn(demoSummaryProgram)()
})

/** Deletes exactly the recorded demo records, then clears the key. Admin. */
export const removeDemoData = createServerFn({ method: 'POST' }).handler(
  async () => {
    await requireAdmin()
    const { removeDemoDataProgram } = await import('../seeds/demo')
    const { effectFn } = await import('./effect')
    return effectFn(removeDemoDataProgram)()
  },
)

/** Runs the host's enrichment on one record now: `enrichment.run`. Any member. */
export const enrichRecord = createServerFn({ method: 'POST' })
  .validator(z.object({ entityId: z.uuid() }))
  .handler(async ({ data }) => {
    await requireUser()
    const { enqueue } = await import('../queue')
    const { QUEUES } = await import('@spaces/core/queue/names')
    const jobId = await enqueue(QUEUES.enrichmentRun, {
      entityId: data.entityId,
      reason: 'Enrich pressed',
    })
    return { queued: jobId !== null }
  })
