import {
  dayKey,
  daysBetween,
  formatDay,
  formatTime,
  formatWeekday,
} from '@spaces/core/format'
import type { FeedSource, FeedSpaceTag, Headline } from '#/lib/server-fns'

/**
 * The words the Sources table, the feed window and Headlines print about a
 * feed and its stories, kept out of the components so a test reads them
 * without rendering.
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

/** Headlines a page brings, and what `Load 50 more` offers. */
export const HEADLINES_STEP = 50

/** A day band's label: `Today`, `Yesterday`, then `Fri 13 Nov`. */
export function dayBand(at: string, today: string): string {
  const back = daysBetween(at, today)
  if (back === 0) return 'Today'
  if (back === 1) return 'Yesterday'
  return formatWeekday(at, today)
}

/** Stories under their day bands, in the order they came (newest first). */
export function byDay(
  headlines: ReadonlyArray<Headline>,
  today: string,
): Array<{ key: string; label: string; headlines: Array<Headline> }> {
  const out: Array<{ key: string; label: string; headlines: Array<Headline> }> =
    []
  for (const h of headlines) {
    const key = dayKey(h.publishedAt)
    const last = out.at(-1)
    if (last?.key === key) last.headlines.push(h)
    else out.push({ key, label: dayBand(h.publishedAt, today), headlines: [h] })
  }
  return out
}

/** The reader bar's `16 Nov · 10:12`. */
export function storyStamp(at: string, today: string): string {
  return `${formatDay(at, today)} · ${formatTime(at)}`
}

/** The summary's paragraphs: plain text split on blank lines. */
export function paragraphsOf(summary: string | null): Array<string> {
  return (summary ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** The site a story continues on, `spacenews.com`; null with no address. */
export function siteOf(h: Pick<Headline, 'siteUrl' | 'url'>): string | null {
  for (const address of [h.url, h.siteUrl]) {
    if (address === null) continue
    try {
      return new URL(address).hostname.replace(/^www\./, '')
    } catch {
      // Not an address a URL parses: try the next one.
    }
  }
  return null
}

/** The reader's body when the feed carries no text of its own. */
export function headlinesOnlyLine(feedName: string): string {
  return `${feedName} sends headlines only. The story is on its site.`
}

/** A space filter that no feed is tagged to, at or under it. */
export function noFeedLine(spacePath: string): string {
  return `No feed is tagged to ${spacePath}.`
}

/** The space filter's choices: each space a feed is tagged to, by path. */
export function filterSpaces(
  sources: ReadonlyArray<Pick<FeedSource, 'spaces'>>,
  pathOf: ReadonlyMap<string, string>,
): Array<SpaceOption> {
  const byId = new Map<string, SpaceOption>()
  for (const s of sources)
    for (const t of s.spaces)
      byId.set(t.id, { id: t.id, path: pathOf.get(t.id) ?? t.name })
  return [...byId.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Whether a feed is tagged to `spaceId` or to a space under it — what the
 * Headlines filter keeps, read from the tags rather than the stories, so a
 * tagged feed still waiting on its first fetch is not called untagged.
 */
export function hasFeedUnder(
  spaceId: string,
  sources: ReadonlyArray<Pick<FeedSource, 'spaces'>>,
  parentOf: ReadonlyMap<string, string | null>,
): boolean {
  for (const s of sources)
    for (const t of s.spaces) {
      const seen = new Set<string>()
      let at: string | null = t.id
      while (at !== null && !seen.has(at)) {
        if (at === spaceId) return true
        seen.add(at)
        at = parentOf.get(at) ?? null
      }
    }
  return false
}

/**
 * The story the reader shows: the chosen one while it is in the list, else
 * the newest.
 */
export function selectedOf(
  headlines: ReadonlyArray<Headline>,
  chosen: string | null,
): Headline | null {
  return headlines.find((h) => h.id === chosen) ?? headlines.at(0) ?? null
}

/** What Ask starts with for `Ask about this`: the headline and its link. */
export function askDraft(h: Pick<Headline, 'title' | 'url'>): string {
  return h.url === null ? `${h.title}\n\n` : `${h.title}\n${h.url}\n\n`
}

/** `Its 214 headlines go with it.`; nothing when it holds none. */
export function removeBody(count: number): string | undefined {
  if (count === 0) return undefined
  return count === 1
    ? 'Its one headline goes with it.'
    : `Its ${count.toLocaleString('en-US')} headlines go with it.`
}
