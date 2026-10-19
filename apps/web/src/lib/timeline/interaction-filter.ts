/**
 * The Interactions tab's filters: every kind, one, or those with attachments.
 * The tab head's count reads the same filter, so the two agree. Client-safe.
 */
export const INTERACTION_FILTERS = [
  'all',
  'email',
  'meeting',
  'call',
  'attachments',
] as const
export type InteractionFilter = (typeof INTERACTION_FILTERS)[number]

type Filterable = { kind: string; hasAttachments: boolean }

/** Whether a row is listed under a filter. */
export function inInteractionFilter(
  i: Filterable,
  filter: InteractionFilter,
): boolean {
  if (filter === 'all') return true
  if (filter === 'attachments') return i.hasAttachments
  return i.kind === filter
}

/** How many rows each interaction filter lists. */
export function interactionCounts(
  interactions: ReadonlyArray<Filterable>,
): Record<InteractionFilter, number> {
  const of = (f: InteractionFilter) =>
    interactions.filter((i) => inInteractionFilter(i, f)).length
  return {
    all: interactions.length,
    email: of('email'),
    meeting: of('meeting'),
    call: of('call'),
    attachments: of('attachments'),
  }
}
