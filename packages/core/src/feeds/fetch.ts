import { PICTURE_MAX_BYTES } from '../enrichment/picture'
import type { FeedItem } from './feed'

/**
 * The poller's rules, pure: its clock, its caps, the sentences a failing
 * feed shows, which failures are worth a retry, and how a parsed item
 * becomes a stored headline; and the caps and clocks of a feed's pictures,
 * which the worker stores as blobs and never hotlinks.
 */

/** Every feed is fetched on this clock (UTC). */
export const FEED_POLL_CRON = '*/30 * * * *'

/** Headlines are kept this long by their published time, then deleted. */
export const FEED_RETENTION_DAYS = 90

/** A feed document larger than this is refused, not buffered. */
export const FEED_MAX_BYTES = 5 * 1024 * 1024

/** One fetch, every redirect and the body read included. */
export const FEED_TIMEOUT_MS = 20_000

/** What a feed fetch asks for: a feed first, a page to find one in second. */
export const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5'

/** The sentences the Sources table and the Add feed window show. */
export const FEED_REASONS = {
  timedOut: 'Timed out',
  notAFeed: 'Not a feed any more',
  noFeed: 'That page has no feed',
  unreachable: 'Could not reach the site',
  tooLarge: 'The feed is too large',
  notAnAddress: 'That is not a web address',
} as const

/** "The site answered 404". */
export const answeredReason = (status: number): string =>
  `The site answered ${String(status)}`

/** A guarded fetch that did not land, as the guard describes it. */
export type FailedFetch = {
  readonly kind: 'refused' | 'network'
  readonly reason: string
  readonly status?: number
  readonly timedOut?: boolean
  readonly tooLarge?: boolean
}

/**
 * Why a feed fetch failed, in the feed's words, and whether to try again
 * before the next tick.
 * - A 4xx other than 429 is the site's answer and will be the same in a
 *   minute: not retried. A timeout, a 5xx, a 429 or a dropped connection
 *   may pass: retried.
 * - A refusal is the guard's own judgement (a private address, the byte
 *   cap, a redirect loop) and never changes on a retry.
 */
export type FeedFetchFailure = {
  readonly reason: string
  readonly status: number | null
  readonly retryable: boolean
}

export const fetchFailureOf = (failed: FailedFetch): FeedFetchFailure => {
  if (failed.status !== undefined) {
    const status = failed.status
    return {
      reason: answeredReason(status),
      status,
      retryable: status === 429 || status >= 500,
    }
  }
  if (failed.timedOut === true)
    return { reason: FEED_REASONS.timedOut, status: null, retryable: true }
  if (failed.tooLarge === true)
    return { reason: FEED_REASONS.tooLarge, status: null, retryable: false }
  if (failed.kind === 'refused')
    return { reason: failed.reason, status: null, retryable: false }
  return { reason: FEED_REASONS.unreachable, status: null, retryable: true }
}

/** A headline as it is stored. */
export type FeedItemRow = {
  readonly key: string
  readonly url: string | null
  readonly title: string
  readonly summary: string | null
  readonly publishedAt: Date
  readonly imageUrl: string | null
}

const TITLE_MAX = 300

const oneLine = (text: string): string => {
  const line = text.split('\n').at(0)?.trim() ?? ''
  return line.length <= TITLE_MAX
    ? line
    : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`
}

/** The day `now` stops keeping headlines from. */
export const retentionCutoff = (now: Date): Date =>
  new Date(now.getTime() - FEED_RETENTION_DAYS * 24 * 60 * 60 * 1000)

/**
 * Parsed items as rows to insert, seen at `now`.
 * - No date, or a date in the future, is `now`: first seen.
 * - An item already past retention is never stored, so the daily delete
 *   does not take back what a fetch just put in.
 * - No title borrows the summary's first line, then the link, then the key.
 */
export const itemRowsOf = (
  items: ReadonlyArray<FeedItem>,
  now: Date,
): ReadonlyArray<FeedItemRow> => {
  const cutoff = retentionCutoff(now)
  const seen = new Set<string>()
  return items.flatMap((item) => {
    if (seen.has(item.key)) return []
    seen.add(item.key)
    const dated = item.publishedAt === null ? now : new Date(item.publishedAt)
    const publishedAt = dated.getTime() > now.getTime() ? now : dated
    if (publishedAt.getTime() < cutoff.getTime()) return []
    const title =
      [item.title, item.summary, item.url]
        .map((t) => (t === null ? '' : oneLine(t)))
        .find((t) => t !== '') ?? item.key
    return [
      {
        key: item.key,
        url: item.url,
        title,
        summary: item.summary,
        publishedAt,
        imageUrl: item.imageUrl,
      },
    ]
  })
}

/**
 * The cap on one item photo. Larger than a record picture's: a story's
 * lead image is a photograph at article width, stored as fetched.
 */
export const FEED_IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** A logo is an icon or a masthead: a record picture's cap. */
export const FEED_LOGO_MAX_BYTES = PICTURE_MAX_BYTES

/** One picture fetch, every redirect and the body read included. */
export const FEED_IMAGE_TIMEOUT_MS = 15_000

/** Item photos fetched at once within one job: polite to one host. */
export const FEED_IMAGE_CONCURRENCY = 4

/** Item ids one `feed.images` job carries; a larger batch is split. */
export const FEED_IMAGE_BATCH = 50

const HOUR_MS = 60 * 60 * 1000

/**
 * How long a headline's photo waits after its first, second and third
 * failed fetch before it is tried again. A fourth failure is final.
 */
export const FEED_IMAGE_RETRY_WAITS_MS = [
  1 * HOUR_MS,
  6 * HOUR_MS,
  24 * HOUR_MS,
] as const

/**
 * The failure count at which a photo is never fetched again: every wait
 * spent, or a refusal that no later try can change.
 */
export const FEED_IMAGE_GIVEN_UP = FEED_IMAGE_RETRY_WAITS_MS.length + 1

/** Photos one poll sends back for another try, in `FEED_IMAGE_BATCH` jobs. */
export const FEED_IMAGE_RETRIES_PER_POLL = 4 * FEED_IMAGE_BATCH

/**
 * Whether a headline's photo may be fetched at `now`, given how many times
 * it has failed and when it last did. Never failed is due; failed n times
 * (1 to 3) is due once the nth wait has passed since `failedAt`; given up
 * is never due.
 */
export const photoFetchDue = (
  failures: number,
  failedAt: Date | null,
  now: Date,
): boolean => {
  if (failures <= 0) return true
  const wait = FEED_IMAGE_RETRY_WAITS_MS.at(failures - 1)
  if (wait === undefined) return false
  // A count with no instant has nothing to wait from.
  if (failedAt === null) return true
  return now.getTime() - failedAt.getTime() >= wait
}

/**
 * The same rule as {@link photoFetchDue} for a query: per failure count, the
 * latest failure instant that is due at `now`.
 */
export const photoRetryCutoffs = (
  now: Date,
): Array<{ readonly failures: number; readonly failedBy: Date }> =>
  FEED_IMAGE_RETRY_WAITS_MS.map((wait, i) => ({
    failures: i + 1,
    failedBy: new Date(now.getTime() - wait),
  }))

/** Every source's logo is fetched again weekly (UTC, Sunday early). */
export const FEED_LOGO_CRON = '40 5 * * 0'

/**
 * What a picture fetch asks for: the raster types `judgePicture` takes. No
 * AVIF, which the sniffer does not read, so a negotiating CDN sends another.
 */
export const FEED_IMAGE_ACCEPT =
  'image/webp, image/png, image/jpeg, image/gif, image/x-icon, */*;q=0.5'
