import type { ReactNode } from 'react'
import { CORE_OBJECTS } from '@spaces/core/attributes/registry'
import { AttributeDialog } from './attribute-dialog'

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
      objectPlural={CORE_OBJECTS[objectKind].plural}
      trigger={trigger}
      onSaved={onCreated}
    />
  )
}
