import { Link } from '@tanstack/react-router'
import { LabelHead } from '#/components/ledger-section'
import type { AskCardsRow } from '#/lib/server-fns'
import { SuggestionCard } from './suggestion-card'

/**
 * Action cards an Ask thread left undecided, under a head naming the thread.
 * The members are the ordinary per-record cards: Accept runs the same writer
 * Apply did in the thread.
 */
export function AskThreadGroup({ group }: { group: AskCardsRow }) {
  return (
    <li className="flex flex-col gap-3">
      <LabelHead label={`Ask · ${group.title}`}>
        <Link
          to="/ask"
          search={{ thread: group.id }}
          className="focus-ring shrink-0 mono text-micro text-graphite hover:text-foreground"
        >
          Open thread ›
        </Link>
      </LabelHead>
      <ul
        aria-label={`Cards from ${group.title}`}
        className="flex flex-col gap-3"
      >
        {group.cards.map((card) => (
          <SuggestionCard key={card.id} card={card} />
        ))}
      </ul>
    </li>
  )
}
