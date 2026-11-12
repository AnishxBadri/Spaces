import { Effect, Schema } from 'effect'
import { defineManifest } from '@spaces/sdk'

/** A record's id, as the settings form checks it (`pattern`, not `format: uuid`). */
export const RECORD_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A host name of dot-separated labels ending in a letters-only TLD. */
const DOMAIN =
  /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/

/** An absolute http(s) URL, spelled with `://`, on a domain name. */
const isFeedUrl = (text: string): boolean => {
  const trimmed = text.trim()
  if (!/^https?:\/\//i.test(trimmed) || !URL.canParse(trimmed)) return false
  return DOMAIN.test(new URL(trimmed).hostname)
}

/**
 * RSS's manifest: a poller.
 * - One `schedule` job. `uses` has no Identity and no Facts: an item is a
 *   signal on the record the settings name, never a new entity and never a
 *   value.
 * - One integration row is one feed. The settings are scalars because the
 *   Integrations form draws string, number, boolean and enum only; many
 *   feeds per row is the watch plugins' shape.
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'rss',
  version: '0.1.0',
  sdk: '^2.0',
  name: 'RSS',
  roles: ['feeds'],
  description:
    "Polls one RSS or Atom feed and adds each new item to a record's timeline as a signal; an item is added once, however often the feed repeats it.",
  settings: Schema.Struct({
    feedUrl: Schema.String.annotate({
      format: 'uri',
      title: 'Feed URL',
      description: 'An RSS 2.0 or Atom feed.',
    }).check(Schema.makeFilter(isFeedUrl)),
    record: Schema.String.annotate({
      title: 'Record id',
      description: 'The record its items become signals on.',
    }).check(Schema.isPattern(RECORD_ID)),
    maxItems: Schema.Int.annotate({
      title: 'Items per poll',
      description: 'The newest items read each time; older ones are ignored.',
    })
      .check(Schema.isBetween({ minimum: 1, maximum: 100 }))
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed(20))),
  }),
  jobs: {
    poll: {
      trigger: 'schedule',
      schedule: '*/30 * * * *',
      uses: ['Config', 'Http', 'PluginDb', 'Content', 'Log'],
    },
  },
})
