import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { fireRecordAction } from '#/lib/server-fns'
import type { RecordAction } from '#/lib/server-fns'

/**
 * A record head's plugin actions: one outline button per manifest action
 * declared on this record's kind, beside the record's own. (D63)
 * - The list comes from the loader, which offers only runnable plugins; a
 *   stopped one is absent here and explained on Today and Review.
 * - Firing enqueues the plugin's job and returns at once; the result lands
 *   in the record when the worker has run it.
 */
export function PluginActions({
  entityId,
  actions,
}: {
  entityId: string
  actions: ReadonlyArray<RecordAction>
}) {
  return actions.map((action) => (
    <PluginActionButton
      key={`${action.integrationId}:${action.actionId}`}
      entityId={entityId}
      action={action}
    />
  ))
}

function PluginActionButton({
  entityId,
  action,
}: {
  entityId: string
  action: RecordAction
}) {
  const [pending, setPending] = useState(false)

  async function fire() {
    setPending(true)
    try {
      const result = await fireRecordAction({
        data: {
          integrationId: action.integrationId,
          actionId: action.actionId,
          entityId,
        },
      })
      if (result.status === 'queued')
        toast(`${action.label} queued · ${action.pluginName}`)
      else toast.error('The worker queue is unreachable; try again shortly')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not start ${action.label}`,
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      variant="outline"
      pending={pending}
      onClick={() => void fire()}
      title={`${action.label} with ${action.pluginName}`}
    >
      {action.label}
    </Button>
  )
}
