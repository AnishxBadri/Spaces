import { Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AttributeDialog } from './attribute-dialog'
import type { EditableAttribute } from './attribute-dialog'
import { ValueEditor } from './value-editor'
import type { RefNames, RegistryEntry } from './value-editor'
import {
  PropertyCell,
  REJECT_HOLD_MS,
  REJECT_LEAVE_MS,
} from '#/components/record/record-parts'
import type { RejectPhase } from '#/components/record/record-parts'

/**
 * One labelled attribute in a record's property grid. A rejected write (a
 * required attribute cleared, an invalid value) is shown inline under the
 * field and the editor remounts to the stored value — not a toast-and-revert
 * the reader has to reconcile across the screen. The server's message is
 * `slug: detail`; the slug is redundant next to the label, so it's cut.
 *
 * The visual half of that path (DESIGN.md §5, Micro-interactions; SPA-53):
 * the snap back to the stored value is what the remount already does, and the
 * cell reads crimson in place for two seconds on top of it. It runs off the
 * rejection `setValues` already returns — the same rejected promise the error
 * line reads — so nothing asks the server a second time.
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
  refNames?: RefNames | undefined
  onSave: (value: unknown) => Promise<void>
  /** the attribute row, when the rail may open the edit dialog (spec §7) */
  attr?: EditableAttribute | undefined
  objectLabel?: string | undefined
  onAttributeSaved?: (() => void) | undefined
}) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false)
  const [reject, setReject] = useState<RejectPhase>('rest')

  // The clock behind the two-second hold. `attempt` is in the deps so a
  // second rejection during a hold restarts it rather than being swallowed
  // by a phase that did not change.
  useEffect(() => {
    if (reject === 'rest') return
    const leaving = reject === 'leaving'
    const t = setTimeout(
      () => setReject(leaving ? 'rest' : 'leaving'),
      leaving ? REJECT_LEAVE_MS : REJECT_HOLD_MS - REJECT_LEAVE_MS,
    )
    return () => clearTimeout(t)
  }, [reject, attempt])

  return (
    <PropertyCell
      className="group/rail"
      reject={reject}
      label={
        <>
          <span
            className="min-w-0 truncate"
            {...(def.description ? { title: def.description } : {})}
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
            () => {
              setError(null)
              setReject('rest')
            },
            (err: unknown) => {
              const raw = err instanceof Error ? err.message : 'Could not save'
              setError(raw.replace(new RegExp(`^${def.slug}: `), ''))
              setAttempt((n) => n + 1)
              setReject('hold')
            },
          )
        }}
      />
    </PropertyCell>
  )
}
