import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { RailSection } from '#/components/record/record-parts'
import type { OpenSuggestionCount, SuggestionKind } from '#/lib/server-fns'

/**
 * The record rail's "Waiting" lane (SPA-114): open suggestions on this
 * record, one chip per kind, each a link into `/inbox` scoped to the record
 * and its suggestion lane. Grouped by kind rather than listed, so fifty open
 * suggestions are still at most five chips — one wrapped row.
 *
 * **A pointer, never a verb (D44).** Inline accept/reject on the chip was
 * considered and declined: accept and reject live in the inbox only, so
 * SPA-110's bulk accept has one path to build on rather than two to keep in
 * step. Do not add an action here — link to the inbox instead.
 *
 * Nothing waiting → no section, no zero: the component answers `null`.
 */

const WORD: Record<SuggestionKind, [one: string, many: string]> = {
  attribute_patch: ['proposed', 'proposed'],
  note: ['note', 'notes'],
  ledger_event: ['ledger event', 'ledger events'],
  identity: ['identity', 'identities'],
  document_kind: ['document kind', 'document kinds'],
}

export function suggestionChipWord(kind: SuggestionKind, n: number): string {
  const [one, many] = WORD[kind]
  return n === 1 ? one : many
}

export function WaitingRail({
  entityId,
  counts,
}: {
  entityId: string
  counts: ReadonlyArray<OpenSuggestionCount>
}) {
  if (counts.length === 0) return null
  return (
    <RailSection label="Waiting">
      <div className="flex flex-wrap gap-1.5">
        {counts.map((c) => (
          <Link
            key={c.kind}
            to="/inbox"
            search={{ record: entityId, lane: 'suggestions' }}
            className="mention-chip focus-ring"
          >
            <Sparkles size={12} strokeWidth={1.75} aria-hidden />
            <span className="tabular mono">{c.count}</span>
            {suggestionChipWord(c.kind, c.count)}
          </Link>
        ))}
      </div>
    </RailSection>
  )
}
