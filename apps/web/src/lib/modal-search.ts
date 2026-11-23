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

/**
 * A new email's window: `?modal=email&new=1&draft=<id>`, with `template=`
 * applied as it opens. `draft` is the id the email saves under, so the same
 * URL reopens the same draft once it is saved.
 */
export const composeSearchShape = {
  new: caught(Schema.Literal(1)),
  draft: caught(uuidString),
  template: caught(uuidString),
}

export const modalSearchShape = {
  modal: caught(Schema.Literals(MODALS)),
  id: caught(uuidString),
  ...composeSearchShape,
}

export const modalSearch = searchValidator(Schema.Struct(modalSearchShape))

/** The id of the `modal` window the search opens, else null. */
export function openModalId(
  search: { modal?: Modal | undefined; id?: string | undefined },
  modal: Modal,
): string | null {
  return search.modal === modal && search.id !== undefined ? search.id : null
}

/** The new email the search opens, else null; `draftId` null until minted. */
export function openComposeOf(search: {
  modal?: string | undefined
  new?: 1 | undefined
  draft?: string | undefined
  template?: string | undefined
}): { draftId: string | null; templateId: string | null } | null {
  if (search.modal !== 'email' || search.new !== 1) return null
  return { draftId: search.draft ?? null, templateId: search.template ?? null }
}

/** The keys that open a new email's window, under a freshly minted id. */
export function composeSearch(templateId: string | null = null) {
  return {
    modal: 'email' as const,
    new: 1 as const,
    draft: crypto.randomUUID(),
    ...(templateId === null ? {} : { template: templateId }),
  }
}
