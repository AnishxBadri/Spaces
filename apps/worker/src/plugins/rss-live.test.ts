import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { eq, isNotNull, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import { activity, entity, integration, signal } from '@spaces/db/schema'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { dropPluginSchemaStatement } from '@spaces/core/writes/plugins/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { JobPermanent } from '@spaces/sdk'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { JOURNAL_TABLE, pluginSchemaName } from './plugin-db'

/**
 * The rss plugin end to end on the live ports, over the test database: the
 * real bundle installed with its migrations, loaded as boot loads it, wired
 * on the host and its schedule job invoked as the queue would. The feeds are
 * the committed fixtures, served from disk by the Http port's fetch seam —
 * no network, no socket. Plugin schemas outlive the harness's truncate of
 * `public`, so each test starts by dropping plugin_rss.
 */

const rssDir = fileURLToPath(
  new URL('../../../../plugins/rss/', import.meta.url),
)
const RSS_URL = 'https://northwind-robotics.example/news/feed.xml'
const ATOM_URL = 'https://contoso-labs.example/blog/atom.xml'
const FEEDS = new Map([
  [RSS_URL, 'rss2.xml'],
  [ATOM_URL, 'atom.xml'],
])
const RSS = pluginSchemaName('rss')

const NoEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

/** Every request the Http port made, and the fixture it was answered with. */
const requested: Array<string> = []
const fetchFixture: FetchLike = (url) => {
  requested.push(url)
  const file = FEEDS.get(url)
  return Promise.resolve(
    file === undefined
      ? new Response('not found', { status: 404 })
      : new Response(readFileSync(path.join(rssDir, 'fixtures', file)), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
  )
}

const hosts: Array<PluginHost> = []

beforeEach(async () => {
  requested.length = 0
  // Signals cite their row, so the last test's rows are switched off, not deleted.
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  await db.execute(dropPluginSchemaStatement('rss'))
})

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
})

const seedCompany = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

/** dist/ — bundle, manifest and migrations — as `<root>/rss/current/`, one row, loaded and wired. */
const installRss = async (config: { feedUrl: string; record: string }) => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-rss-')),
    'plugins',
  )
  const dir = path.join(root, 'rss', 'current')
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(rssDir, 'dist'), dir, { recursive: true })
  const row = (
    await db
      .insert(integration)
      .values({ capabilityId: 'rss', version: '0.1.0', enabled: true, config })
      .returning()
  ).at(0)
  if (!row) throw new Error('no row')
  const { loaded, verdicts } = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const host = makePluginHost({
    enqueue: NoEnqueue,
    fetch: fetchFixture,
    sink: () => undefined,
  })
  hosts.push(host)
  const wired = await Effect.runPromise(host.wire(loaded))
  expect(wired.map((v) => v.line)).toEqual(['[plugins] rss: wired poll'])
  return { row, host, loadLine: verdicts.at(0)?.line ?? '' }
}

const poll = (host: PluginHost, integrationId: string) =>
  Effect.runPromiseExit(host.invoke(integrationId, 'poll', { cursor: null }))

const rowsOf = async <TRow extends Record<string, unknown>>(text: string) =>
  (await db.$client.query<TRow>(text)).rows

const entityCount = async () =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(entity)).at(0)?.n ??
  -1

const feedItems = () =>
  rowsOf<{ item_key: string; signal_id: string | null }>(
    `select item_key, signal_id::text from "${RSS}".feed_item order by id`,
  )

const signalsOf = (integrationId: string) =>
  db.select().from(signal).where(eq(signal.sourceRef, integrationId))

describe('rss on the live ports', () => {
  it('migrates plugin_rss.feed_item on first load', async () => {
    const companyId = await seedCompany(
      'Northwind Robotics',
      'northwind.example',
    )
    const { loadLine } = await installRss({
      feedUrl: RSS_URL,
      record: companyId,
    })
    expect(loadLine).toContain('migrated 0001_feed_item.sql')
    const tables = await rowsOf<{ name: string }>(
      `select table_name::text as name from information_schema.tables
        where table_schema = '${RSS}' order by 1`,
    )
    expect(tables.map((t) => t.name)).toEqual(['feed_item', JOURNAL_TABLE])
  })

  it('emits each item once as a signal on the configured record, naming the integration, and creates no entity', async () => {
    const companyId = await seedCompany(
      'Northwind Robotics',
      'northwind.example',
    )
    const { row, host } = await installRss({
      feedUrl: RSS_URL,
      record: companyId,
    })
    const entities = await entityCount()

    const first = await poll(host, row.id)
    expect(first).toEqual(Exit.succeed({ nextCursor: null }))
    expect(requested).toEqual([RSS_URL])

    const signals = await signalsOf(row.id)
    expect(signals).toHaveLength(4)
    for (const s of signals) {
      expect(s).toMatchObject({
        entityId: companyId,
        source: 'rss',
        sourceClass: 'integration',
        sourceRef: row.id,
      })
    }
    expect(signals.map((s) => s.payload)).toContainEqual({
      kind: 'feed',
      title: 'Northwind closes its Series B',
      url: 'https://northwind-robotics.example/news/series-b',
      publishedAt: '2026-10-05T09:00:00.000Z',
      payload: {
        feedUrl: RSS_URL,
        itemKey: 'northwind-news-0004',
        feedTitle: 'Northwind Robotics — Newsroom',
        summary: 'Northwind raised $40M led by Example Ventures & friends.',
      },
    })
    const timeline = await db
      .select()
      .from(activity)
      .where(eq(activity.verb, 'signal.emitted'))
    expect(timeline).toHaveLength(4)
    expect(timeline.every((a) => a.subjectEntityId === companyId)).toBe(true)

    const items = await feedItems()
    expect(items.map((i) => i.item_key)).toEqual([
      'northwind-news-0001',
      'https://northwind-robotics.example/news/grocer-pilot',
      'northwind-news-0003',
      'northwind-news-0004',
    ])
    expect(new Set(items.map((i) => i.signal_id))).toEqual(
      new Set(signals.map((s) => s.id)),
    )

    // The same feed again: a row per item already, so nothing new.
    const second = await poll(host, row.id)
    expect(second).toEqual(Exit.succeed({ nextCursor: null }))
    expect(requested).toEqual([RSS_URL, RSS_URL])
    expect(await signalsOf(row.id)).toHaveLength(4)
    expect(await feedItems()).toEqual(items)
    expect(await entityCount()).toBe(entities)
  })

  it('reads an Atom feed the same way', async () => {
    const companyId = await seedCompany('Contoso Labs', 'contoso-labs.example')
    const { row, host } = await installRss({
      feedUrl: ATOM_URL,
      record: companyId,
    })
    const entities = await entityCount()
    await poll(host, row.id)
    await poll(host, row.id)
    const signals = await signalsOf(row.id)
    expect(signals.map((s) => s.entityId)).toEqual([
      companyId,
      companyId,
      companyId,
    ])
    expect(await feedItems()).toHaveLength(3)
    expect(await entityCount()).toBe(entities)
  })

  it('a record that does not exist fails the poll, leaves the item unmarked, and the next poll retries it', async () => {
    const missing = '0b5cbe3e-7a4e-4f7e-9b44-3f1c2a9d8e01'
    const { row, host } = await installRss({
      feedUrl: RSS_URL,
      record: missing,
    })
    const entities = await entityCount()

    const failed = await poll(host, row.id)
    const error = Exit.isFailure(failed)
      ? Option.getOrNull(Cause.findErrorOption(failed.cause))
      : null
    expect(error).toBeInstanceOf(JobPermanent)
    expect(error?.reason).toBe(`Content.emitSignal: no record ${missing}`)
    expect(await feedItems()).toEqual([
      { item_key: 'northwind-news-0001', signal_id: null },
    ])
    expect(await signalsOf(row.id)).toEqual([])
    expect(await entityCount()).toBe(entities)

    // The record turns up; the claimed item is emitted with the rest.
    await db
      .insert(entity)
      .values({ id: missing, kind: 'company', canonicalName: 'Late Robotics' })
    expect(await poll(host, row.id)).toEqual(Exit.succeed({ nextCursor: null }))
    const items = await feedItems()
    expect(items).toHaveLength(4)
    expect(items.every((i) => i.signal_id !== null)).toBe(true)
    expect(await signalsOf(row.id)).toHaveLength(4)
  })

  it('holds exactly the five ports a poller is granted: no Facts, no Identity', async () => {
    const companyId = await seedCompany(
      'Northwind Robotics',
      'northwind.example',
    )
    const { row, host } = await installRss({
      feedUrl: RSS_URL,
      record: companyId,
    })
    expect(host.granted(row.id, 'poll')).toEqual([
      'Config',
      'Content',
      'Http',
      'Log',
      'PluginDb',
    ])
  })
})
