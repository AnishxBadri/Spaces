import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { user } from './auth'
import { space } from './kinds'

/** How a feed's last fetch ended; a 304 is `ok`. */
export const FEED_FETCH_STATUSES = ['ok', 'failed'] as const

/**
 * A feed the workspace reads: owned by no one, tagged to spaces, fetched by
 * the worker every half hour.
 * - `url` is the feed document itself, never the site page it was found on.
 * - `last_error` is the sentence the Sources table shows; null once a fetch
 *   succeeds again.
 * - `etag` and `last_modified` are the site's validators, sent back on the
 *   next fetch so an unchanged feed answers 304.
 * - `logo_sha` is a blob digest the worker fills, never a hotlink.
 */
export const feed = pgTable(
  'feed',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    siteUrl: text('site_url'),
    name: text('name').notNull(),
    logoSha: text('logo_sha'),
    addedBy: text('added_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastStatus: text('last_status', { enum: FEED_FETCH_STATUSES }),
    lastError: text('last_error'),
    etag: text('etag'),
    lastModified: text('last_modified'),
  },
  (t) => [
    uniqueIndex('feed_url_unique').on(t.url),
    check(
      'feed_last_status_known',
      sql`${t.lastStatus} IS NULL OR ${t.lastStatus} IN ('ok', 'failed')`,
    ),
  ],
)

/** A feed's spaces. Either side going removes the tag. */
export const feedSpace = pgTable(
  'feed_space',
  {
    feedId: uuid('feed_id')
      .notNull()
      .references(() => feed.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.entityId, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.feedId, t.spaceId] }),
    index('feed_space_space_idx').on(t.spaceId),
  ],
)

/**
 * One headline. Kept 90 days by `published_at`, then deleted.
 * - `key` is the item's guid (Atom id), else its link: what makes a second
 *   fetch insert nothing.
 * - `published_at` is the feed's date, else when the worker first saw it.
 * - `summary` is the feed's own text in plain paragraphs, capped: the
 *   reader's only body, since the article page is never fetched.
 * - `image_url` is where the feed says the photo is; `image_sha` is the copy
 *   the worker stores.
 */
export const feedItem = pgTable(
  'feed_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedId: uuid('feed_id')
      .notNull()
      .references(() => feed.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    url: text('url'),
    title: text('title').notNull(),
    summary: text('summary'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    imageUrl: text('image_url'),
    imageSha: text('image_sha'),
  },
  (t) => [
    uniqueIndex('feed_item_key_unique').on(t.feedId, t.key),
    index('feed_item_published_idx').on(t.publishedAt, t.id),
    index('feed_item_feed_published_idx').on(t.feedId, t.publishedAt),
  ],
)
