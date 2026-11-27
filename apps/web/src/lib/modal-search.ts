import { Option, Schema } from 'effect'
import { uuidString } from '@spaces/core/attributes/registry'
import { caught, searchValidator } from './search-validator'

/**
 * The window a page opens over itself from its URL: `?modal=meeting&id=`,
 * `?modal=email&id=`, `?modal=note&id=` (the id is the note's) and
 * `?modal=file&id=`, with `&page=` for the page a PDF opens at. Anything
 * else reads as no window. Spread `modalSearchShape` into a route's own
 * search schema.
 */
export const MODALS = ['meeting', 'email', 'note', 'file'] as const
export type Modal = (typeof MODALS)[number]

/**
 * A new email's window: `?modal=email&new=1&draft=<id>`, with `template=`
 * applied as it opens. `draft` is the id the email saves under, so the same
 * URL reopens the same draft once it is saved. `reconnected=gmail` is where
 * Reconnect Gmail's consent lands: the draft opens on Review, with a toast.
 */
export const composeSearchShape = {
  new: caught(Schema.Literal(1)),
  draft: caught(uuidString),
  template: caught(uuidString),
  reconnected: caught(Schema.Literal('gmail')),
}

/** A file window's page: 1-based. */
const filePage = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const modalSearchShape = {
  modal: caught(Schema.Literals(MODALS)),
  id: caught(uuidString),
  page: caught(filePage),
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

const FileWindowSearch = Schema.Struct({
  modal: Schema.Literal('file'),
  id: uuidString,
  page: caught(filePage),
})
const decodeFileWindow = Schema.decodeUnknownOption(FileWindowSearch)

/**
 * The file window a location's raw search opens, else null. The file window
 * opens over every page, so it reads the URL itself rather than trusting a
 * route's schema, which may not know `modal=file` (Email's does not).
 */
export function openFileWindowOf(
  search: unknown,
): { id: string; page: number | null } | null {
  return Option.match(decodeFileWindow(search), {
    onNone: () => null,
    onSome: ({ id, page }) => ({ id, page: page ?? null }),
  })
}

/** The keys that open a file's window over the page it is opened from. */
export function fileWindowSearch(id: string, page: number | null = null) {
  return {
    modal: 'file' as const,
    id,
    ...(page === null ? {} : { page }),
  }
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
