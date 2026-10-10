import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { manifestSchema, satisfiesSdk } from '@spaces/sdk'
import { build } from 'vite'
import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import { manifest } from './manifest.ts'

/**
 * The rss bundle as the loader will find it: `vite build` with this
 * package's config writes dist/bundle.mjs, dist/manifest.json and
 * dist/migrations/.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string) =>
  readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8')

let bundle = ''
let emitted: unknown

beforeAll(async () => {
  await build({ root, configFile: `${root}vite.config.ts`, logLevel: 'silent' })
  bundle = read('bundle.mjs')
  emitted = JSON.parse(read('manifest.json'))
}, 60_000)

describe('the rss bundle', () => {
  it('imports @spaces/sdk, effect and zod and nothing else', () => {
    const bare = [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (m) => m[1],
    )
    expect(bare.sort()).toEqual(['@spaces/sdk', 'effect', 'zod'])
    expect(bundle).not.toMatch(/node_modules/)
  })

  it('ships its migrations beside the bundle', () => {
    expect(readdirSync(new URL('../dist/migrations', import.meta.url))).toEqual(
      ['0001_feed_item.sql'],
    )
    expect(read('migrations/0001_feed_item.sql')).toBe(
      readFileSync(
        new URL('../migrations/0001_feed_item.sql', import.meta.url),
        'utf8',
      ),
    )
  })
})

describe('the rss manifest.json', () => {
  it('declares one schedule job with a cron — a poller', () => {
    const parsed = manifestSchema.parse(emitted)
    expect(parsed.id).toBe('rss')
    expect(parsed.roles).toEqual(['feeds'])
    expect(satisfiesSdk(parsed.sdk)).toEqual({ ok: true })
    expect(parsed.jobs).toEqual({
      poll: {
        trigger: 'schedule',
        schedule: '*/30 * * * *',
        uses: ['Config', 'Http', 'PluginDb', 'Content', 'Log'],
      },
    })
    expect(parsed.requires).toBeUndefined()
  })

  /**
   * Scalars only, each with the keywords the Integrations settings form
   * draws (string with format or pattern, integer with bounds): the feed is
   * configured there with no rss-specific code.
   */
  it('carries the feed as three scalar settings', () => {
    expect(manifestSchema.parse(emitted).settings).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        feedUrl: {
          type: 'string',
          format: 'uri',
          title: 'Feed URL',
          description: 'An RSS 2.0 or Atom feed.',
        },
        record: {
          type: 'string',
          pattern:
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          title: 'Record id',
          description: 'The record its items become signals on.',
        },
        maxItems: {
          type: 'integer',
          default: 20,
          minimum: 1,
          maximum: 100,
          title: 'Items per poll',
          description:
            'The newest items read each time; older ones are ignored.',
        },
      },
      required: ['feedUrl', 'record'],
      propertyOrder: ['feedUrl', 'record', 'maxItems'],
    })
  })

  it('refuses a feed that is not http(s) and a record that is not an id', () => {
    const ok = {
      feedUrl: 'https://x.example/feed.xml',
      record: '0b5cbe3e-7a4e-4f7e-9b44-3f1c2a9d8e01',
    }
    expect(z.parse(manifest.settings, ok)).toEqual({ ...ok, maxItems: 20 })
    for (const bad of [
      { ...ok, feedUrl: 'ftp://x.example/feed.xml' },
      { ...ok, record: 'Northwind' },
      { ...ok, maxItems: 0 },
    ]) {
      expect(z.safeParse(manifest.settings, bad).success).toBe(false)
    }
  })

  it('has the version the package declares', () => {
    const pkg = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        ),
      )
    expect(manifestSchema.parse(emitted).version).toBe(pkg.version)
  })
})
