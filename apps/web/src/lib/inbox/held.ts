import { z } from 'zod'
import type { InboxRow, SuggestionItem, SuggestionRow } from '#/lib/inbox/queue'

/**
 * A decision held for its undo window: what it is, as the beacon carries it
 * when the page goes, and which rows it hides while it waits. Pure, so the
 * client store, the beacon route and the queue's filter read one shape.
 */

const uuid = z.uuid()

export const heldDecisionSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('accept'), id: uuid }),
  z.object({ verb: z.literal('dismiss'), id: uuid }),
  z.object({
    verb: z.literal('accept-column'),
    attributeSlug: z.string().min(1).max(200),
    runId: uuid.nullable(),
  }),
  z.object({ verb: z.literal('dismiss-duplicate'), candidateId: uuid }),
  z.object({ verb: z.literal('apply-card'), suggestionId: uuid }),
  z.object({ verb: z.literal('skip-card'), suggestionId: uuid }),
])

export type HeldDecision = z.infer<typeof heldDecisionSchema>
export type HeldVerb = HeldDecision['verb']

/** The beacon's body: every decision still held when the page went. */
export const heldBeaconSchema = z.object({
  decisions: z.array(heldDecisionSchema).min(1).max(200),
})

/**
 * The sentence an accept or dismiss of a suggestion decided elsewhere fails
 * with. One spelling, so the hold can tell "already decided" (silent) from a
 * refusal (the row comes back with the error).
 */
export const alreadyDecidedMessage = (status: string): string =>
  `This suggestion was already ${status}`

export const isAlreadyDecided = (failure: unknown): boolean =>
  failure instanceof Error &&
  failure.message.startsWith(alreadyDecidedMessage(''))

/** What the held decisions hide, read once per render. */
export type HeldView = {
  /** Suggestion, candidate and card ids. */
  ids: ReadonlySet<string>
  /** Column accepts: the field, on every record or only one run's. */
  columns: ReadonlyArray<{ slug: string; runId: string | null }>
}

export const NOTHING_HELD: HeldView = { ids: new Set(), columns: [] }

export function heldView(decisions: Iterable<HeldDecision>): HeldView {
  const ids = new Set<string>()
  const columns: Array<{ slug: string; runId: string | null }> = []
  for (const d of decisions) {
    switch (d.verb) {
      case 'accept':
      case 'dismiss':
        ids.add(d.id)
        break
      case 'dismiss-duplicate':
        ids.add(d.candidateId)
        break
      case 'apply-card':
      case 'skip-card':
        ids.add(d.suggestionId)
        break
      case 'accept-column':
        columns.push({ slug: d.attributeSlug, runId: d.runId })
        break
    }
  }
  return { ids, columns }
}

/** Whether a row, a suggestion, a pair or a card is waiting out its hold. */
export const isHeld = (view: HeldView, id: string): boolean => view.ids.has(id)

/**
 * Whether a field change's field is held by a column accept — the same rows
 * `acceptColumnProgram` takes: every open patch proposing the slug, or only
 * one run's.
 */
export const isHeldField = (
  view: HeldView,
  item: Pick<SuggestionItem, 'kind' | 'runId'>,
  slug: string,
): boolean =>
  item.kind === 'attribute_patch' &&
  view.columns.some(
    (c) => c.slug === slug && (c.runId === null || c.runId === item.runId),
  )

/** A suggestion less what is held: its held fields gone, or null when nothing is left. */
export function visibleSuggestion(
  view: HeldView,
  item: SuggestionItem,
): SuggestionItem | null {
  if (isHeld(view, item.id)) return null
  if (item.fields === null || view.columns.length === 0) return item
  const fields = item.fields.filter((f) => !isHeldField(view, item, f.slug))
  if (fields.length === item.fields.length) return item
  return fields.length === 0 ? null : { ...item, fields }
}

function visibleCard(
  view: HeldView,
  card: SuggestionRow,
): SuggestionRow | null {
  const suggestions = card.suggestions.flatMap((s) => {
    const shown = visibleSuggestion(view, s)
    return shown === null ? [] : [shown]
  })
  return suggestions.length === 0 ? null : { ...card, suggestions }
}

const visibleCards = (view: HeldView, cards: ReadonlyArray<SuggestionRow>) =>
  cards.flatMap((c) => {
    const shown = visibleCard(view, c)
    return shown === null ? [] : [shown]
  })

/**
 * The queue as the reader sees it while decisions are held: held rows,
 * suggestions and fields gone, a group with nothing left gone with them.
 * - A discovery group stays, empty, so an accept's after-state can draw
 *   in it once the write lands; `hasOpenItems` is what counts it.
 */
export function withoutHeld(
  rows: ReadonlyArray<InboxRow>,
  view: HeldView,
): Array<InboxRow> {
  if (view.ids.size === 0 && view.columns.length === 0) return [...rows]
  return rows.flatMap((row): Array<InboxRow> => {
    switch (row.kind) {
      case 'duplicate_candidate':
        return isHeld(view, row.id) ? [] : [row]
      case 'suggestion': {
        const shown = visibleCard(view, row)
        return shown === null ? [] : [shown]
      }
      case 'column_run':
      case 'ask_cards': {
        const cards = visibleCards(view, row.cards)
        return cards.length === 0 ? [] : [{ ...row, cards }]
      }
      case 'discovery':
        return [
          {
            ...row,
            suggestions: row.suggestions.filter((s) => !isHeld(view, s.id)),
          },
        ]
    }
  })
}

/** Whether a row still asks the reader for anything. */
export const hasOpenItems = (row: InboxRow): boolean =>
  row.kind !== 'discovery' || row.suggestions.length > 0
