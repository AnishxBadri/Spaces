import { Schema } from 'effect'
import { uuidString } from '@spaces/core/attributes/registry'
import { caught, searchValidator } from './search-validator'

/**
 * The window a page opens over itself from its URL: `?modal=meeting&id=`,
 * `?modal=email&id=` and `?modal=note&id=` (the id is the note's). Anything
 * else reads as no window. Spread `modalSearchShape` into a route's own
 * search schema.
 */
export const MODALS = ['meeting', 'email', 'note'] as const
export type Modal = (typeof MODALS)[number]

export const modalSearchShape = {
  modal: caught(Schema.Literals(MODALS)),
  id: caught(uuidString),
}

export const modalSearch = searchValidator(Schema.Struct(modalSearchShape))

/** The id of the `modal` window the search opens, else null. */
export function openModalId(
  search: { modal?: Modal | undefined; id?: string | undefined },
  modal: Modal,
): string | null {
  return search.modal === modal && search.id !== undefined ? search.id : null
}
