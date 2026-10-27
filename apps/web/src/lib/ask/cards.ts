import type { HeldVerb } from '#/lib/inbox/held'
import type { AskCardKind, AskRef } from './types'

/**
 * Ask's action cards: the eight-card catalogue, the card as the thread draws
 * it, and the renderer's refusal. Pure, so the turn, the dock and the tests
 * read one table.
 * - A card is a proposal; applying it is a person's act through the writer a
 *   person would use. The agent never applies one.
 * - Attribute values are not a card: they go through `propose_suggestion`.
 */

export type AskCardEntry = {
  kind: AskCardKind
  /** The card's head, as the thread prints it. */
  label: string
  /** False: named so the vocabulary is whole, refused by `propose_card`. */
  available: boolean
}

export const ASK_CARD_CATALOGUE: ReadonlyArray<AskCardEntry> = [
  { kind: 'task', label: 'Create task', available: true },
  { kind: 'move_stage', label: 'Move stage', available: true },
  { kind: 'file_into_space', label: 'File into a space', available: true },
  { kind: 'log_signal', label: 'Log signal', available: false },
  { kind: 'note', label: 'Note', available: false },
  { kind: 'draft_email', label: 'Draft email', available: false },
  { kind: 'add_record', label: 'Add record', available: false },
  { kind: 'save_as_watch', label: 'Save as watch', available: false },
]

/** A kind's catalogue entry. */
export function cardEntry(kind: AskCardKind): AskCardEntry {
  return (
    ASK_CARD_CATALOGUE.find((e) => e.kind === kind) ?? {
      kind,
      label: kind,
      available: false,
    }
  )
}

/**
 * Where a card stands.
 * - `proposed`: still streaming, not yet stored.
 * - `open`: stored and undecided; it waits in Review too.
 * - `conflict`: applied, and the writer found nothing to do — the stage was
 *   already there, the record already filed — so nothing was written.
 */
export type AskCardOutcome =
  'proposed' | 'open' | 'applied' | 'skipped' | 'conflict'

export type AskCardView = {
  /** The suggestion's id; the tool call's while it streams. */
  id: string
  kind: AskCardKind
  record: { id: string; name: string; href: string | null }
  summary: string
  rationale: string
  evidence: ReadonlyArray<AskRef>
  outcome: AskCardOutcome
  /** A stage card not applied because the deal moved or closed since. */
  moved: boolean
}

/** A card the renderer will draw: one with evidence. Null refuses it. */
export function renderableCard(card: AskCardView): AskCardView | null {
  return card.evidence.length > 0 ? card : null
}

/**
 * An open card as it reads while its decision is held: applied or skipped,
 * before the write. Any other card, or any other verb, reads as it stands.
 */
export function heldOutcome(card: AskCardView, verb: HeldVerb): AskCardView {
  if (card.outcome !== 'open') return card
  switch (verb) {
    case 'apply-card':
    case 'accept':
      return { ...card, outcome: 'applied' }
    case 'skip-card':
    case 'dismiss':
      return { ...card, outcome: 'skipped' }
    case 'accept-column':
    case 'dismiss-duplicate':
    case 'add-option':
      return card
  }
}

/** The mono state word an outcome reads as; null while it can be decided. */
export function outcomeWord(card: AskCardView): string | null {
  switch (card.outcome) {
    case 'proposed':
    case 'open':
      return null
    case 'applied':
      return 'applied'
    case 'skipped':
      return 'skipped'
    case 'conflict':
      return card.kind === 'move_stage'
        ? card.moved
          ? 'conflict · stage moved since'
          : 'not applied · already at that stage'
        : card.kind === 'file_into_space'
          ? 'not applied · already filed'
          : 'not applied'
  }
}

/** A `YYYY-MM-DD` that names a real day: `2026-02-30` does not. */
export function isCalendarDate(day: string): boolean {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (parts === null) return false
  const at = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])),
  )
  return at.toISOString().slice(0, 10) === day
}
