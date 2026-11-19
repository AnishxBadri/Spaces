import { createServerFn } from '@tanstack/react-start'
import { Schema } from 'effect'
import { requireUser } from './shared'
import { input } from './input'

const uuid = Schema.String.check(Schema.isUUID())

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

/** The manifest actions a record of `kind` carries in its head. */
export const listRecordActions = createServerFn()
  .validator(
    input(
      Schema.Struct({ kind: Schema.Literals(['company', 'person', 'deal']) }),
    ),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const { recordActionsProgram } = await import('../integrations/actions')
    const { effectFn } = await import('./effect')
    return effectFn(recordActionsProgram)(data.kind)
  })

/** Fire one: enqueues the plugin's job and returns at once. Any member. */
export const fireRecordAction = createServerFn({ method: 'POST' })
  .validator(
    input(
      Schema.Struct({
        integrationId: uuid,
        actionId: Schema.String.check(Schema.isMinLength(1)),
        entityId: uuid,
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { fireRecordActionHandler } = await import('../integrations/actions')
    return fireRecordActionHandler(data)
  })
