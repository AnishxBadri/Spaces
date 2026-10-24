import type { AttributeType } from './registry'
import type { Json } from '@spaces/db/json'
import type { Cardinality } from './relationship'

/**
 * Edits widen only: a single-valued attribute may become multi-valued,
 * never the reverse.
 * - `select` widens to `multi_select`; a reference, phone or email keeps its
 *   type and gains `multi`.
 * - Every other type has no list shape and does not widen.
 */

/** Whether the attribute holds a list. */
export const holdsList = (def: {
  type: string
  options: { multi?: boolean | undefined }
}): boolean => def.type === 'multi_select' || def.options.multi === true

/** The type a single-valued attribute widens to; null when it has no list shape. */
export function widenedType(type: AttributeType): AttributeType | null {
  switch (type) {
    case 'select':
      return 'multi_select'
    case 'record_reference':
    case 'phone':
    case 'email':
      return type
    default:
      return null
  }
}

/** A relationship read from a side that now holds many: its target becomes the N. */
export const widenCardinality = (card: Cardinality): Cardinality =>
  card === '1:1' ? '1:N' : card === 'N:1' ? 'N:N' : card

/** A stored default in the widened shape: a scalar becomes a one-element list. */
export const widenDefault = (value: Json): Json =>
  value === null || Array.isArray(value) ? value : [value]
