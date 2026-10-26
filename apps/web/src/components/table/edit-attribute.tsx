import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { AttributeDialog } from '#/components/attributes/attribute-dialog'
import type { EditableAttribute } from '#/components/attributes/attribute-dialog'
import type { ColumnAction } from './record-table'

/**
 * `Edit attribute…` in a registry column's head menu: the attribute editor
 * the record rail and the settings page open, in edit mode, on the
 * column's attribute. The list route renders `dialog` beside its table.
 */
export function useEditAttribute<
  T extends EditableAttribute & { slug: string },
>({
  registry,
  objectId,
  objectLabel,
  objectPlural,
  fillFrom,
  onSaved,
}: {
  registry: ReadonlyArray<T>
  /** The object row, for a custom object; a core kind's editor needs none. */
  objectId?: string | undefined
  /** Singular noun for the editor's copy — `company`. */
  objectLabel: string
  /** Plural for the editor's head — `on Companies`. */
  objectPlural: string
  fillFrom?: 'company' | 'person' | undefined
  onSaved: () => void
}): {
  columnActions: (columnId: string) => ReadonlyArray<ColumnAction>
  dialog: ReactNode
} {
  const [editing, setEditing] = useState<T | null>(null)

  const columnActions = useCallback(
    (columnId: string): ReadonlyArray<ColumnAction> => {
      const def = registry.find((d) => `attr:${d.slug}` === columnId)
      if (def === undefined) return []
      return [
        {
          label: 'Edit attribute…',
          opens: true,
          onSelect: () => setEditing(def),
        },
      ]
    },
    [registry],
  )

  const dialog =
    editing === null ? null : (
      <AttributeDialog
        mode="edit"
        attr={editing}
        objectId={objectId}
        objectLabel={objectLabel}
        objectPlural={objectPlural}
        fillFrom={fillFrom}
        open
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
        onSaved={onSaved}
      />
    )

  return { columnActions, dialog }
}
