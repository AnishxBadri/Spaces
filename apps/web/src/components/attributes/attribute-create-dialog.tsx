import type { ReactNode } from 'react'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import { AttributeDialog } from './attribute-dialog'

/**
 * "+ Add column" / "+ Add attribute" — the morphing dialog in create mode,
 * opened by its `trigger`, or held open by the caller (a menu's last row).
 */
export function AttributeCreateDialog({
  objectKind,
  onCreated,
  ...opener
}: {
  objectKind: 'company' | 'person' | 'deal'
  onCreated: () => void
} & (
  | { trigger: ReactNode }
  | { open: boolean; onOpenChange: (open: boolean) => void }
)) {
  return (
    <AttributeDialog
      mode="create"
      objectKind={objectKind}
      objectPlural={CORE_OBJECTS[objectKind].plural}
      onSaved={onCreated}
      {...opener}
    />
  )
}
