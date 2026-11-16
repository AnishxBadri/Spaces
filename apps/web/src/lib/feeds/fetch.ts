import { Effect, Schema } from 'effect'
import { feedAddressOf, feedLinksOf, parseFeed } from '@spaces/core/feeds/feed'
import type { Feed } from '@spaces/core/feeds/feed'
import {
  FEED_ACCEPT,
  FEED_MAX_BYTES,
  FEED_REASONS,
  FEED_TIMEOUT_MS,
  fetchFailureOf,
} from '@spaces/core/feeds/fetch'
import { guardedFetchProgram } from '#/lib/documents/fetch-guard'

/**
 * A feed over the wire: one guarded fetch, conditional when the feed's
 * validators are known, and a site address resolved to the feed it
 * advertises. Every request goes through the URL guard.
 */

/** A fetch that did not land a feed; `message` is the Sources sentence. */
export class FeedFetchFailed extends Schema.TaggedError<FeedFetchFailed>()(
  'FeedFetchFailed',
  {
    message: Schema.String,
    status: Schema.NullOr(Schema.Number),
    retryable: Schema.Boolean,
  },
) {}

/** The site's validators, sent back so an unchanged feed answers 304. */
export type FeedValidators = {
  readonly etag: string | null
  readonly lastModified: string | null
}

export type FetchedFeed =
  | { readonly _tag: 'NotModified' }
  | {
      readonly _tag: 'Fetched'
      /** After every redirect. */
      readonly url: string
      readonly feed: Feed
      readonly validators: FeedValidators
    }

/** Named honestly on every feed, page and picture request. */
export const FEED_USER_AGENT = 'Spaces/1.0 (+self-hosted feed reader)'

const conditional = (v: FeedValidators): Record<string, string> => ({
  ...(v.etag === null ? {} : { 'if-none-match': v.etag }),
  ...(v.lastModified === null ? {} : { 'if-modified-since': v.lastModified }),
})

/** A fetch that wants the whole document whatever the site last sent. */
export const NO_VALIDATORS: FeedValidators = { etag: null, lastModified: null }

/** The body as text; a feed that is not UTF-8 says so in its prolog. */
const textOf = (bytes: Uint8Array, contentType: string | null): string => {
  const declared =
    /charset=([\w-]+)/i.exec(contentType ?? '')?.at(1) ??
    /^<\?xml[^>]*encoding=["']([\w-]+)["']/i
      .exec(new TextDecoder('latin1').decode(bytes.subarray(0, 200)))
      ?.at(1) ??
    'utf-8'
  try {
    return new TextDecoder(declared).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

type Page = {
  readonly url: string
  readonly text: string
  readonly validators: FeedValidators
}

const fetchPage = Effect.fn('feeds.fetchPage')(function* (
  url: string,
  validators: FeedValidators,
): Effect.fn.Return<Page | null, FeedFetchFailed> {
  const res = yield* guardedFetchProgram(url, {
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    headers: {
      accept: FEED_ACCEPT,
      'user-agent': FEED_USER_AGENT,
      ...conditional(validators),
    },
  })
  if (!res.ok) {
    const failure = fetchFailureOf(res)
    return yield* new FeedFetchFailed({
      message: failure.reason,
      status: failure.status,
      retryable: failure.retryable,
    })
  }
  if (res.status === 304) return null
  return {
    url: res.url,
    text: textOf(res.bytes, res.contentType),
    validators: {
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    },
  }
})

const notAFeed = (message: string) =>
  new FeedFetchFailed({ message, status: null, retryable: false })

/**
 * One poll of a known feed: `NotModified` when the site answered 304 to the
 * validators, else the parsed feed. A document that no longer parses fails
 * "Not a feed any more".
 */
export const fetchFeedProgram = Effect.fn('feeds.fetchFeed')(function* (
  url: string,
  validators: FeedValidators,
): Effect.fn.Return<FetchedFeed, FeedFetchFailed> {
  const page = yield* fetchPage(url, validators)
  if (page === null) return { _tag: 'NotModified' }
  const feed = parseFeed(page.text)
  if (feed === null) return yield* notAFeed(FEED_REASONS.notAFeed)
  return {
    _tag: 'Fetched',
    url: page.url,
    feed,
    validators: page.validators,
  }
})

/** A typed address resolved to a feed, fetched once. */
export type ResolvedFeed = {
  /** The feed document's URL, after redirects: what the row stores. */
  readonly url: string
  readonly feed: Feed
  /** The address the person typed, as a URL. */
  readonly typedUrl: string
}

/**
 * What a person typed, as a feed: the address itself when it is one, else
 * the first RSS or Atom feed its page advertises with `<link rel=
 * "alternate">`. A page with neither fails "That page has no feed".
 */
export const resolveFeedProgram = Effect.fn('feeds.resolveFeed')(function* (
  typed: string,
): Effect.fn.Return<ResolvedFeed, FeedFetchFailed> {
  const address = feedAddressOf(typed)
  if (address === null) return yield* notAFeed(FEED_REASONS.notAnAddress)
  const page = yield* fetchPage(address, NO_VALIDATORS)
  // No validators were sent, so a 304 is a misbehaving site, not a feed.
  if (page === null) return yield* notAFeed(FEED_REASONS.noFeed)
  const direct = parseFeed(page.text)
  if (direct !== null) return { url: page.url, feed: direct, typedUrl: address }

  const advertised = feedLinksOf(page.text, page.url).at(0)
  if (advertised === undefined) return yield* notAFeed(FEED_REASONS.noFeed)
  const linked = yield* fetchPage(advertised, NO_VALIDATORS)
  const feed = linked === null ? null : parseFeed(linked.text)
  if (linked === null || feed === null)
    return yield* notAFeed(FEED_REASONS.noFeed)
  return { url: linked.url, feed, typedUrl: address }
})
