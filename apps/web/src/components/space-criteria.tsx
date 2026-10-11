import { useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { setSpaceCriteria } from '#/lib/server-fns'
import { cn } from '#/lib/utils'

/** The longest criteria the server keeps: a few sentences, not a memo. */
const CRITERIA_MAX = 1000

/**
 * What belongs in a space, edited in place: the paragraph becomes its own
 * field, as the title does on rename. ↵ or leaving the field saves, ⇧↵
 * breaks a line, esc keeps what was there. (D72)
 * - Blank saves as cleared; the prompt shown in its place is never stored.
 */
export function SpaceCriteria({
  spaceId,
  criteria,
}: {
  spaceId: string
  criteria: string | null
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(criteria ?? '')
  // ↵ and the blur that follows must not save twice.
  const settled = useRef(false)

  function open() {
    settled.current = false
    setDraft(criteria ?? '')
    setEditing(true)
  }

  async function save() {
    if (settled.current) return
    settled.current = true
    const next = draft.trim()
    if (next === (criteria ?? '')) return setEditing(false)
    try {
      await setSpaceCriteria({ data: { id: spaceId, criteria: next } })
      void router.invalidate()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not save the criteria',
      )
    } finally {
      setEditing(false)
    }
  }

  return (
    <section aria-label="Criteria" className="flex flex-col gap-1.5 px-3 py-4">
      <span className="label-caps text-graphite">Criteria</span>
      {editing ? (
        <textarea
          autoFocus
          rows={3}
          value={draft}
          aria-label="Criteria"
          maxLength={CRITERIA_MAX}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void save()
            }
            if (e.key === 'Escape') {
              settled.current = true
              setEditing(false)
            }
          }}
          className="text-prose focus-ring w-full min-w-0 resize-none border-b border-rule bg-transparent font-serif leading-6.75 outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={open}
          className={cn(
            'focus-ring -mx-1 max-w-160 px-1 text-left transition-colors hover:bg-bone',
            criteria === null
              ? 'text-ui text-graphite'
              : 'text-prose font-serif leading-6.75 whitespace-pre-wrap',
          )}
        >
          {criteria ?? 'What belongs here, in a sentence or three…'}
        </button>
      )}
    </section>
  )
}
