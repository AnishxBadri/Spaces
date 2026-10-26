import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import type { MoreMenuCheck } from '#/components/ui/more-menu'
import type { StampProps } from '#/components/ui/stamp'
import type { ResolvedSensitivity, SensitivityVia } from '#/lib/ai/sensitivity'
import { setEntitySensitive } from '#/lib/server-fns'

export type SensitivityState = ResolvedSensitivity & { own: boolean }

/** What the item names as the source of an inherited flag. */
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
 * The head `···`'s Sensitive switch. It toggles the record's own
 * `entity.sensitive` and nothing else. A record that is sensitive only
 * because of a filed space (or the workspace default) reads `via <source>`
 * in the item's end lane; the switch stays off and still toggles the
 * record's own flag — inheritance never writes a row.
 *
 * Sensitivity is an egress flag, never access control: it keeps this
 * record's bytes on local models, and hides nothing from anyone — `canRead`
 * stays the only thing that hides a row.
 */
export function useSensitiveItem(
  entityId: string,
  state: SensitivityState,
): MoreMenuCheck {
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
  return {
    label: 'Sensitive',
    checked: state.own,
    disabled: pending,
    hint: inherited === null ? undefined : `via ${inherited}`,
    title: 'Keep this record on local models',
    onCheckedChange: (next) => void toggle(next),
  }
}

/** The page's stamp: the kind, locked while the record is sensitive. */
export function sensitiveStamp(
  kind: string,
  state: ResolvedSensitivity,
): StampProps {
  return state.sensitivity === 'sensitive'
    ? { kind, state: 'sensitive' }
    : { kind }
}
