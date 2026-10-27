import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { applyAskCard, skipAskCard } from '#/lib/server-fns'
import type { AskCardView } from '#/lib/server-fns'
import {
  cardEntry,
  heldOutcome,
  outcomeWord,
  renderableCard,
} from '#/lib/ask/cards'
import { heldDecisions, useHeldEntry } from '#/lib/held-decisions'
import { RefChip } from './ask-answer'

/**
 * Ask's action cards beside an answer: the proposal, its evidence, and one
 * pine Apply with Skip as the outline secondary.
 * - A decided card shows its outcome as a mono state word, never a disabled
 *   button.
 * - A card without evidence is refused: one line says so, never the card.
 * - A proposed card (still streaming) has no verbs until it is stored.
 */

export function AskCard({
  card,
  waiting = false,
}: {
  card: AskCardView
  /** Undecided on an earlier turn: it waits in Review too. */
  waiting?: boolean
}) {
  const [view, setView] = useState(card)
  const held = useHeldEntry(card.id)
  const rendered = renderableCard(view)
  if (rendered === null)
    return (
      <p className="mono text-micro text-graphite">
        A card with no evidence was left out.
      </p>
    )
  // During the hold the card reads as decided; Undo returns it to open.
  const shown = held === undefined ? rendered : heldOutcome(rendered, held.verb)

  const suggestionId = shown.id
  function decide(verb: 'apply' | 'skip') {
    heldDecisions.hold(suggestionId, {
      decision:
        verb === 'apply'
          ? { verb: 'apply-card', suggestionId }
          : { verb: 'skip-card', suggestionId },
      label: `${verb === 'apply' ? 'Applied' : 'Skipped'} on ${shown.record.name}`,
      commit: async () => {
        const next = await (verb === 'apply' ? applyAskCard : skipAskCard)({
          data: { suggestionId },
        })
        setView(next)
      },
    })
  }

  const word = outcomeWord(shown)
  return (
    <li
      data-card={shown.kind}
      data-outcome={shown.outcome}
      className="flex flex-col border border-rule bg-paper"
    >
      <div className="flex flex-col gap-1 px-3 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 label-caps text-graphite">
            {cardEntry(shown.kind).label}
          </span>
          {shown.record.href === null ? (
            <span className="min-w-0 truncate text-label text-graphite">
              {shown.record.name}
            </span>
          ) : (
            <Link
              to={shown.record.href}
              className="focus-ring min-w-0 truncate text-label text-graphite hover:text-foreground"
            >
              {shown.record.name}
            </Link>
          )}
        </div>
        <p className="text-ui font-medium">{shown.summary}</p>
        {shown.rationale === '' ? null : (
          <p className="text-label text-graphite">{shown.rationale}</p>
        )}
        <div className="flex flex-wrap items-center gap-y-1">
          {shown.evidence.map((r) => (
            <RefChip key={r.ref} source={r} />
          ))}
        </div>
      </div>
      {shown.outcome === 'proposed' ? null : (
        <div className="flex min-h-10 items-center justify-end gap-3 border-t border-rule bg-bone px-3 py-1.5">
          {word !== null ? (
            <span className="mr-auto mono text-micro text-graphite">
              {word}
            </span>
          ) : (
            <>
              {waiting ? (
                <Link
                  to="/review"
                  className="focus-ring mr-auto mono text-micro text-graphite hover:text-foreground"
                >
                  waiting in Review ›
                </Link>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => decide('skip')}
              >
                Skip
              </Button>
              <Button size="sm" onClick={() => decide('apply')}>
                Apply
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** A turn's cards under one head that prints their count once. */
export function AskCards({
  cards,
  waiting = false,
}: {
  cards: ReadonlyArray<AskCardView>
  waiting?: boolean
}) {
  if (cards.length === 0) return null
  return (
    <section aria-label="Action cards" className="flex flex-col gap-2">
      <span className="mono text-micro text-graphite">
        {cards.length} {cards.length === 1 ? 'card' : 'cards'}
      </span>
      <ul className="flex flex-col gap-2">
        {cards.map((c) => (
          <AskCard key={`${c.id}:${c.outcome}`} card={c} waiting={waiting} />
        ))}
      </ul>
    </section>
  )
}
