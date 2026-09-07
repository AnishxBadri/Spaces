import { useState } from 'react'
import { ValueEditor } from './value-editor'
import type { RefNames, RegistryEntry } from './value-editor'

/**
 * One labelled attribute in a record rail. A rejected write (a required
 * attribute cleared, an invalid value) is shown inline under the field
 * and the editor remounts to the stored value — not a toast-and-revert
 * the reader has to reconcile across the screen. The server's message is
 * `slug: detail`; the slug is redundant next to the label, so it's cut.
 */
export function RailField({
  def,
  value,
  refNames,
  onSave,
}: {
  def: RegistryEntry
  value: unknown
  refNames?: RefNames
  onSave: (value: unknown) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">
        {def.name}
      </span>
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
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
