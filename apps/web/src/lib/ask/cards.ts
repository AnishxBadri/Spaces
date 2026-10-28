import { formatDay } from '@spaces/core/format'
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
  /** Who decided it: `you` for the reader, else their name; null while open. */
  by: string | null
  /**
   * A stage card not applied because the deal moved or closed since: who
   * last moved the stage (`you`, a name, or null for no person) and when,
   * ISO, from its latest stage event. Null for every other card.
   */
  moved: { by: string | null; at: string | null } | null
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
      return { ...card, outcome: 'applied', by: 'you' }
    case 'skip-card':
    case 'dismiss':
      return { ...card, outcome: 'skipped', by: 'you' }
    case 'accept-column':
    case 'dismiss-duplicate':
    case 'add-option':
      return card
  }
}

/**
 * The state word an outcome reads as, sentence case; null while it can be
 * decided. An applied card says where its write landed: a task in Tasks, a
 * stage or a filing in the record's History.
 */
export function outcomeWord(card: AskCardView, today: string): string | null {
  switch (card.outcome) {
    case 'proposed':
    case 'open':
      return null
    case 'applied':
      if (card.kind === 'task') return 'Applied · in Tasks'
      return card.by === null
        ? 'Applied · in History'
        : `Applied · by ${card.by}, in History`
    case 'skipped':
      return 'Skipped'
    case 'conflict': {
      if (card.kind === 'move_stage' && card.moved !== null) {
        const day =
          card.moved.at === null ? '' : formatDay(card.moved.at, today)
        if (day === '') return 'Not applied · the stage moved since'
        return card.moved.by === null
          ? `Not applied · moved on ${day}`
          : `Not applied · ${card.moved.by} moved it on ${day}`
      }
      return card.kind === 'move_stage'
        ? 'Not applied · already at that stage'
        : card.kind === 'file_into_space'
          ? 'Not applied · already filed'
          : 'Not applied'
    }
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
