import { useEffect, useRef, useState } from 'react'
import { joinName } from '@spaces/core/attributes/person-name'
import { Input } from '#/components/ui/input'
import {
  PropertyCell,
  REJECT_HOLD_MS,
  REJECT_LEAVE_MS,
} from '#/components/record/record-parts'
import type { RejectPhase } from '#/components/record/record-parts'
import { cn } from '#/lib/utils'

export type NameParts = { first_name: string | null; last_name: string | null }

/**
 * A person's name as one property cell (D67): the join at rest, First and
 * Last side by side while editing.
 * - `onDraft` hands the page the join as it is typed, so the record head
 *   previews it; null when the edit ends.
 * - Both parts save in one write; `setValues` rewrites `canonical_name`.
 * - A refused write reads inline and the cell goes crimson, like `RailField`.
 */
export function NameField({
  first,
  last,
  onDraft,
  onSave,
}: {
  first: string | null
  last: string | null
  onDraft: (name: string | null) => void
  onSave: (parts: NameParts) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ first: '', last: '' })
  const [error, setError] = useState<string | null>(null)
  const [reject, setReject] = useState<RejectPhase>('rest')
  const [attempt, setAttempt] = useState(0)
  const group = useRef<HTMLDivElement>(null)
  // Enter and a blur can both end one edit; only the first counts.
  const active = useRef(false)

  useEffect(() => {
    if (reject === 'rest') return
    const leaving = reject === 'leaving'
    const t = setTimeout(
      () => setReject(leaving ? 'rest' : 'leaving'),
      leaving ? REJECT_LEAVE_MS : REJECT_HOLD_MS - REJECT_LEAVE_MS,
    )
    return () => clearTimeout(t)
  }, [reject, attempt])

  function open() {
    setDraft({ first: first ?? '', last: last ?? '' })
    setError(null)
    active.current = true
    setEditing(true)
  }

  function change(next: { first: string; last: string }) {
    setDraft(next)
    onDraft(joinName(next.first, next.last))
  }

  function cancel() {
    if (!active.current) return
    active.current = false
    setEditing(false)
    onDraft(null)
  }

  function commit() {
    if (!active.current) return
    active.current = false
    setEditing(false)
    const parts = {
      first_name: draft.first.trim() || null,
      last_name: draft.last.trim() || null,
    }
    if (parts.first_name === first && parts.last_name === last) {
      onDraft(null)
      return
    }
    // The head keeps the draft until the page reloads the saved name.
    onSave(parts).then(
      () => {
        setError(null)
        setReject('rest')
        onDraft(null)
      },
      (err: unknown) => {
        const raw = err instanceof Error ? err.message : 'Could not save'
        setError(raw.replace(/^(first|last)_name: /, ''))
        setAttempt((n) => n + 1)
        setReject('hold')
        onDraft(null)
      },
    )
  }

  const joined = joinName(first, last)

  return (
    <PropertyCell
      reject={reject}
      label={<span className="min-w-0 truncate">Name</span>}
      below={
        error ? (
          <p role="alert" className="pt-1 text-label text-destructive">
            {error}
          </p>
        ) : null
      }
    >
      {editing ? (
        <div
          ref={group}
          className="flex gap-2 py-1"
          onBlur={(e) => {
            const next = e.relatedTarget
            if (next instanceof Node && group.current?.contains(next)) return
            commit()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="mono text-micro text-graphite uppercase">
              First
            </span>
            <Input
              autoFocus
              value={draft.first}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => change({ ...draft, first: e.target.value })}
              className="h-8 text-ui"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="mono text-micro text-graphite uppercase">
              Last
            </span>
            <Input
              value={draft.last}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => change({ ...draft, last: e.target.value })}
              className="h-8 text-ui"
            />
          </label>
        </div>
      ) : (
        <button
          key={attempt}
          type="button"
          aria-label="Edit name"
          onClick={open}
          className={cn(
            'focus-ring h-8 w-full truncate rounded-md border border-transparent px-2 text-left text-ui transition-colors hover:border-rule',
            joined === '' && 'text-graphite',
          )}
        >
          {joined === '' ? '—' : joined}
        </button>
      )}
    </PropertyCell>
  )
}
