import { Effect } from 'effect'
import {
  Content,
  Http,
  JobPermanent,
  JobRetryable,
  Log,
  PluginDb,
  configOf,
  definePlugin,
} from '@spaces/sdk'
import type { JsonObject, SignalClaim } from '@spaces/sdk'
import { parseFeed } from './feed.ts'
import type { Feed, FeedItem } from './feed.ts'
import { manifest } from './manifest.ts'

/** The signal kind every item is emitted as. */
export const SIGNAL_KIND = 'feed'

const ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8'

/**
 * Claim the item, or find it already claimed: always one row back, whose
 * `signal_id` is null when the item has no signal yet.
 */
export const UPSERT_ITEM = `insert into feed_item (feed_url, record_id, item_key, title, url, published_at)
values ($1, $2, $3, $4, $5, $6)
on conflict (feed_url, record_id, item_key) do update set last_seen_at = now()
returning signal_id`

export const MARK_EMITTED = `update feed_item set signal_id = $4
where feed_url = $1 and record_id = $2 and item_key = $3`

const fetchFeed = Effect.fn('rss.fetchFeed')(function* (url: string) {
  const response = yield* (yield* Http).request({
    method: 'GET',
    url,
    headers: { accept: ACCEPT },
  })
  if (response.status >= 500) {
    return yield* new JobRetryable({
      reason: `${url} answered ${response.status}`,
    })
  }
  if (response.status !== 200) {
    return yield* new JobPermanent({
      reason: `${url} answered ${response.status}`,
    })
  }
  const feed = parseFeed(response.body)
  if (feed === null) {
    return yield* new JobPermanent({
      reason: `${url} is not an RSS or Atom feed`,
    })
  }
  return feed
})

/** The item as a signal: its own fields, the rest kept in `payload`. */
export const signalClaim = (
  record: string,
  feedUrl: string,
  feed: Feed,
  item: FeedItem,
): SignalClaim => {
  const payload: JsonObject = {
    feedUrl,
    itemKey: item.key,
    ...(feed.title === null ? {} : { feedTitle: feed.title }),
    ...(item.summary === null ? {} : { summary: item.summary }),
  }
  return {
    _tag: 'signal',
    entityId: record,
    kind: SIGNAL_KIND,
    ...(item.title === null ? {} : { title: item.title }),
    ...(item.url === null ? {} : { url: item.url }),
    ...(item.publishedAt === null ? {} : { publishedAt: item.publishedAt }),
    payload,
  }
}

/**
 * One poll: fetch, then per item claim its row and emit it if it has no
 * signal yet, oldest first so the timeline reads in order.
 * - The row is claimed before the emit and marked after it: an emit that
 *   fails leaves the row unmarked, and the next poll retries it.
 * - A crash between emit and mark emits that one item twice. Two
 *   connections cannot share a transaction; at-least-once is the trade.
 * - The cursor is unused: a feed has no paging, and what was seen lives in
 *   feed_item.
 */
export const poll = Effect.fn('rss.poll')(function* () {
  const { feedUrl, record, maxItems } = yield* configOf(manifest)
  const feed = yield* fetchFeed(feedUrl)
  const items = feed.items.slice(0, maxItems).reverse()
  const db = yield* PluginDb
  const content = yield* Content
  let emitted = 0
  for (const item of items) {
    const key = [feedUrl, record, item.key]
    const claimed = yield* db.query(UPSERT_ITEM, [
      ...key,
      item.title,
      item.url,
      item.publishedAt,
    ])
    if (typeof claimed.at(0)?.signal_id === 'string') continue
    const { signalId } = yield* content.emitSignal(
      signalClaim(record, feedUrl, feed, item),
    )
    yield* db.query(MARK_EMITTED, [...key, signalId])
    emitted++
  }
  yield* (yield* Log).info('polled', {
    feedUrl,
    format: feed.format,
    items: items.length,
    emitted,
  })
  return { nextCursor: null }
})

export const jobs = { poll }

export default definePlugin({ manifest, jobs })
