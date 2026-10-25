import type { Cardinality } from '@spaces/db/schema/attributes'

/**
 * The pure half of a relationship: two `record_reference` attributes
 * joined by `options.inverseOf`, the value stored once on the owner.
 * Cardinality is always read from an attribute's own side.
 */
export type { Cardinality }

/** The same relationship read from the other side. */
export function flipCardinality(card: Cardinality): Cardinality {
  return card === '1:N' ? 'N:1' : card === 'N:1' ? '1:N' : card
}

/** Whether the side reading `card` holds many records: its target is the `N`. */
export const holdsMany = (card: Cardinality): boolean => card.endsWith('N')

/**
 * Which side of the dialog owns the value: the "many" side for N:1 and 1:N,
 * which holds a single reference; the side it was opened from (`a`) for
 * N:N and 1:1.
 */
export const ownerSide = (card: Cardinality): 'a' | 'b' =>
  card === '1:N' ? 'b' : 'a'

/** The inverse half of a pair: real, listed, and never stored. */
export const isDerived = (def: {
  type: string
  options: { derived?: true }
}): boolean => def.type === 'record_reference' && def.options.derived === true
