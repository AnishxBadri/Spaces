import { z } from 'zod'
import { defineManifest } from '@spaces/sdk'

/** A record's id, as the settings form checks it (`pattern`, not `format: uuid`). */
export const RECORD_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * RSS's manifest: a poller.
 * - One `schedule` job. `uses` has no Identity and no Facts: an item is a
 *   signal on the record the settings name, never a new entity and never a
 *   value.
 * - One integration row is one feed. The settings are scalars because the
 *   Integrations form draws string, number, boolean and enum only; many
 *   feeds per row is the watch plugins' shape. (D72)
 */
export const manifest = defineManifest({
  manifestVersion: 1,
  id: 'rss',
  version: '0.1.0',
  sdk: '^1.4',
  name: 'RSS',
  roles: ['feeds'],
  description:
    "Polls one RSS or Atom feed and adds each new item to a record's timeline as a signal; an item is added once, however often the feed repeats it.",
  settings: z.object({
    feedUrl: z.httpUrl().meta({
      title: 'Feed URL',
      description: 'An RSS 2.0 or Atom feed.',
    }),
    record: z.string().regex(RECORD_ID).meta({
      title: 'Record id',
      description: 'The record its items become signals on.',
    }),
    maxItems: z.int().min(1).max(100).default(20).meta({
      title: 'Items per poll',
      description: 'The newest items read each time; older ones are ignored.',
    }),
  }),
  jobs: {
    poll: {
      trigger: 'schedule',
      schedule: '*/30 * * * *',
      uses: ['Config', 'Http', 'PluginDb', 'Content', 'Log'],
    },
  },
})
