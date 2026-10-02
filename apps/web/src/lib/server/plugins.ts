import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { requireUser } from './shared'

/**
 * Plugins as the app's surfaces see them: health, and the manifest actions a
 * record head offers. Programs are imported inside the handlers so their
 * database code never reaches the client bundle.
 */

export type { StoppedPlugin } from '../integrations/status'
export type { ActionFired, RecordAction } from '../integrations/actions'

/** Plugins switched on and not running, for Today and Review. */
export const listStoppedPlugins = createServerFn().handler(async () => {
  await requireUser()
  const { stoppedPluginsProgram } = await import('../integrations/status')
  const { effectFn } = await import('./effect')
  return effectFn(stoppedPluginsProgram)()
})

/** The manifest actions a record of `kind` carries in its head. (D63) */
export const listRecordActions = createServerFn()
  .validator(z.object({ kind: z.enum(['company', 'person', 'deal']) }))
  .handler(async ({ data }) => {
    await requireUser()
    const { recordActionsProgram } = await import('../integrations/actions')
    const { effectFn } = await import('./effect')
    return effectFn(recordActionsProgram)(data.kind)
  })

/** Fire one: enqueues the plugin's job and returns at once. Any member. */
export const fireRecordAction = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      integrationId: z.string().uuid(),
      actionId: z.string().min(1),
      entityId: z.string().uuid(),
    }),
  )
  .handler(async ({ data }) => {
    const { fireRecordActionHandler } = await import('../integrations/actions')
    return fireRecordActionHandler(data)
  })
