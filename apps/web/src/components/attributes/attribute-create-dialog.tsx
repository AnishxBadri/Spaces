import { AttributeDialog } from './attribute-dialog'
import type { ReactNode } from 'react'

/** "+ Add column" / "+ Add attribute" — the morphing dialog in create mode. */
export function AttributeCreateDialog({
  objectKind,
  trigger,
  onCreated,
}: {
  objectKind: 'company' | 'person' | 'deal'
  trigger: ReactNode
  onCreated: () => void
}) {
  return (
    <AttributeDialog
      mode="create"
      objectKind={objectKind}
      trigger={trigger}
      onSaved={onCreated}
    />
  )
}
