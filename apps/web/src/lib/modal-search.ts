import { z } from 'zod'

/**
 * The window a page opens over itself from its URL: `?modal=meeting&id=`
 * (D74), and `?modal=email&id=` beside it. Anything else reads as no window.
 * Spread `modalSearchShape` into a route's own search schema.
 */
export const MODALS = ['meeting', 'email'] as const
export type Modal = (typeof MODALS)[number]

export const modalSearchShape = {
  modal: z.enum(MODALS).optional().catch(undefined),
  id: z.uuid().optional().catch(undefined),
}

export const modalSearch = z.object(modalSearchShape)

/** The id of the `modal` window the search opens, else null. */
export function openModalId(
  search: { modal?: Modal | undefined; id?: string | undefined },
  modal: Modal,
): string | null {
  return search.modal === modal && search.id !== undefined ? search.id : null
}
