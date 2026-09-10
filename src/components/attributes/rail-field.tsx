import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { AttributeDialog } from './attribute-dialog'
import type { EditableAttribute } from './attribute-dialog'
import { ValueEditor } from './value-editor'
import type { RefNames, RegistryEntry } from './value-editor'
import { PropertyCell } from '#/components/record/record-parts'

/**
 * One labelled attribute in a record's property grid. A rejected write (a
 * required attribute cleared, an invalid value) is shown inline under the
 * field and the editor remounts to the stored value — not a toast-and-revert
 * the reader has to reconcile across the screen. The server's message is
 * `slug: detail`; the slug is redundant next to the label, so it's cut.
 */
export function RailField({
  def,
  value,
  refNames,
  onSave,
  attr,
  objectLabel,
  onAttributeSaved,
}: {
  def: RegistryEntry
  value: unknown
  refNames?: RefNames
  onSave: (value: unknown) => Promise<void>
  /** the attribute row, when the rail may open the edit dialog (spec §7) */
  attr?: EditableAttribute
  objectLabel?: string
  onAttributeSaved?: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)

  return (
    <PropertyCell
      className="group/rail"
      label={
        <>
          <span
            className="min-w-0 truncate"
            title={def.description ?? undefined}
          >
            {def.name}
          </span>
          {attr ? (
            <button
              type="button"
              aria-label={`Edit attribute ${def.name}`}
              title="Edit attribute"
              onClick={() => setEditing(true)}
              className="focus-ring flex size-4 shrink-0 items-center justify-center text-graphite opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 hover:text-foreground focus-visible:opacity-100"
            >
              <Pencil className="size-2.5" strokeWidth={1.75} />
            </button>
          ) : null}
        </>
      }
      below={
        error ? (
          <p role="alert" className="pt-1 text-label text-destructive">
            {error}
          </p>
        ) : null
      }
    >
      {attr ? (
        <AttributeDialog
          mode="edit"
          attr={attr}
          objectLabel={objectLabel}
          open={editing}
          onOpenChange={setEditing}
          onSaved={() => onAttributeSaved?.()}
        />
      ) : null}
      <ValueEditor
        key={attempt}
        def={def}
        value={value}
        variant="field"
        refNames={refNames}
        onSave={(v) => {
          onSave(v).then(
            () => setError(null),
            (err: unknown) => {
              const raw = err instanceof Error ? err.message : 'Could not save'
              setError(raw.replace(new RegExp(`^${def.slug}: `), ''))
              setAttempt((n) => n + 1)
            },
          )
        }}
      />
    </PropertyCell>
  )
}
