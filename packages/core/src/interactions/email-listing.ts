import type { InteractionMeta } from '@spaces/db/schema/interactions'

/**
 * What an email row lists under its subject: the cached one-line summary,
 * Gmail's snippet as its fallback, and the category labels (D67).
 * - Derived display text, never a proposal and never an attribute: the
 *   summarize and classify lanes write `meta.summary` and `meta.categories`.
 * - All three come from the body, so they are hidden with it: a reader who
 *   may not read the body sees none of them.
 * - `meta.labels` is the mailbox's own labels (the exclude list reads them),
 *   which is why the lane's labels are `categories`.
 */

/** The categories the classify lane may give an email. */
export const EMAIL_CATEGORIES = [
  'intro',
  'pitch',
  'update',
  'scheduling',
  'diligence',
  'legal',
  'portfolio',
  'admin',
] as const

export type EmailCategory = (typeof EMAIL_CATEGORIES)[number]

export const isEmailCategory = (value: string): value is EmailCategory =>
  EMAIL_CATEGORIES.some((c) => c === value)

/** At most this many categories on one email. */
export const EMAIL_CATEGORIES_MAX = 3

/** The summary's ceiling in characters: two lines of the row at most. */
export const EMAIL_SUMMARY_MAX = 240

export type EmailListing = {
  summary: string | null
  /** Shown only when there is no summary, unmarked. */
  snippet: string | null
  categories: Array<EmailCategory>
}

const NOTHING: EmailListing = { summary: null, snippet: null, categories: [] }

/** One email's listing for a reader; nothing when the body is not theirs to read. */
export function emailListing(
  meta: InteractionMeta | null,
  bodyReadable: boolean,
): EmailListing {
  if (!bodyReadable || meta?.kind !== 'email') return NOTHING
  const summary = clean(meta.summary)
  return {
    summary,
    snippet: summary === null ? clean(meta.snippet) : null,
    categories: (meta.categories ?? []).filter(isEmailCategory),
  }
}

/**
 * A model's or a mailbox's line as the row prints it: whitespace collapsed,
 * cut at `max` on a word with an ellipsis. Null when nothing is left.
 */
export function clean(
  text: string | undefined,
  max = EMAIL_SUMMARY_MAX,
): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (flat === '') return null
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const word = cut.lastIndexOf(' ')
  return `${(word > max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`
}
