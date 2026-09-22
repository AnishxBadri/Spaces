import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '#/components/ui/switch'
import type { ResolvedSensitivity, SensitivityVia } from '#/lib/ai/sensitivity'
import { setEntitySensitive } from '#/lib/server-fns'

/** What the marker names as the source of an inherited flag. */
function viaLabel(via: SensitivityVia): string | null {
  switch (via.kind) {
    case 'own':
      return null
    case 'space':
      return via.name
    case 'binding':
      return via.name ?? 'storage binding'
    case 'default':
      return 'workspace default'
  }
}

/**
 * The record header's Sensitive switch (SPA-61). It toggles the record's own
 * `entity.sensitive` and nothing else. A record that is sensitive only
 * because of a filed space (or the workspace default) shows a read-only
 * marker naming where it came from; the switch beside it stays off and still
 * toggles the record's own flag — inheritance never writes a row.
 *
 * Sensitivity is an egress flag, never access control: it keeps this
 * record's bytes on local models, and hides nothing from anyone — `canRead`
 * stays the only thing that hides a row.
 */
export function SensitiveToggle({
  entityId,
  state,
}: {
  entityId: string
  state: ResolvedSensitivity & { own: boolean }
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function toggle(next: boolean) {
    setPending(true)
    try {
      await setEntitySensitive({ data: { entityId, sensitive: next } })
      await router.invalidate()
    } catch {
      toast.error('Could not change sensitivity')
    } finally {
      setPending(false)
    }
  }

  const inherited =
    !state.own && state.sensitivity === 'sensitive' ? viaLabel(state.via) : null

  return (
    <div className="flex shrink-0 items-center gap-3">
      {inherited ? (
        <span className="truncate text-label text-graphite">
          Sensitive · via {inherited}
        </span>
      ) : null}
      <Switch
        checked={state.own}
        disabled={pending}
        onCheckedChange={(next) => void toggle(next)}
      >
        Sensitive
      </Switch>
    </div>
  )
}
