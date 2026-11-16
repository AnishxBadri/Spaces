import { formatWhen } from '@spaces/core/format'

/**
 * The words feeds print outside the Feeds page, kept out of the components
 * so a test reads them without rendering.
 */

/** `14 new headlines`; `1 new headline`. */
export function newHeadlinesLine(count: number): string {
  return count === 1 ? '1 new headline' : `${String(count)} new headlines`
}

/**
 * Where Today's headlines came from: `Feeds · SpaceNews, Inc42 and 3 more`.
 * Three names print whole; past three, two and the count of the rest.
 */
export function headlineFeedsLine(feeds: ReadonlyArray<string>): string {
  const named =
    feeds.length <= 1
      ? feeds.join('')
      : feeds.length <= 3
        ? `${feeds.slice(0, -1).join(', ')} and ${feeds.at(-1) ?? ''}`
        : `${feeds.slice(0, 2).join(', ')} and ${String(feeds.length - 2)} more`
  return named === '' ? 'Feeds' : `Feeds · ${named}`
}

/** A feed's Watching meta: `feed · 10:12`, its newest headline's time. */
export function feedWatchLine(newestAt: string | null, now: string): string {
  return `feed · ${newestAt === null ? '—' : formatWhen(newestAt, now)}`
}
