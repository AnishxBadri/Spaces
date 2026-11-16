import { formatDay } from '@spaces/core/format'
import type { FeedSource, FeedSpaceTag } from '#/lib/server-fns'

/**
 * The words the Sources table and the feed window print about a feed, kept
 * out of the components so a test reads them without rendering.
 */

/** What a feed is filed under, as the space picker names it. */
export type SpaceOption = { readonly id: string; readonly path: string }

/** The day a failing feed last landed: its last success, else when it was added. */
const failingSince = (source: FeedSource): string =>
  source.lastSuccessAt ?? source.createdAt

/** `Couldn't fetch since 13 Nov` — the failing row's Latest lane. */
export function failingLine(source: FeedSource, today: string): string {
  return `Couldn't fetch since ${formatDay(failingSince(source), today)}`
}

/** A site that answers 404 or 410 has most likely moved its feed. */
const MOVED = /^The site answered 4(04|10)$/

/**
 * The Fix window's notice: `Couldn't fetch since 13 Nov. The site answered
 * 404, so the feed has likely moved.`
 */
export function fixNotice(source: FeedSource, today: string): string {
  const head = `${failingLine(source, today)}.`
  const reason = source.lastError?.trim() ?? ''
  if (reason === '') return head
  if (MOVED.test(reason))
    return `${head} ${reason}, so the feed has likely moved.`
  return `${head} ${reason.endsWith('.') ? reason : `${reason}.`}`
}

/**
 * A feed's spaces by their paths (`Aerospace › Launch, Proptech`); a tag
 * the picker's list does not hold prints its own name.
 */
export function spacesLine(
  tags: ReadonlyArray<FeedSpaceTag>,
  pathOf: ReadonlyMap<string, string>,
): string {
  return tags.map((t) => pathOf.get(t.id) ?? t.name).join(', ')
}

/** `Its 214 headlines go with it.`; nothing when it holds none. */
export function removeBody(count: number): string | undefined {
  if (count === 0) return undefined
  return count === 1
    ? 'Its one headline goes with it.'
    : `Its ${count.toLocaleString('en-US')} headlines go with it.`
}
