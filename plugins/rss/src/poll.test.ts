import { readFileSync } from 'node:fs'
import { Cause, Effect, Exit, Layer } from 'effect'
import { JobPermanent, JobRetryable, PluginDb } from '@spaces/sdk'
import type { JsonObject, JsonValue } from '@spaces/sdk'
import {
  ConfigTest,
  ContentTest,
  FactsTest,
  HttpTest,
  IdentityTest,
  LogTest,
  makeRecorder,
} from '@spaces/sdk/testing'
import type { HttpScript, Recorder } from '@spaces/sdk/testing'
import { describe, expect, it } from 'vitest'
import plugin, { MARK_EMITTED, SIGNAL_KIND, UPSERT_ITEM } from './index.ts'

/**
 * The poll job on the SDK's test Layers. The kit has no PluginDb (a plugin's
 * SQL is Postgres's to judge — the worker's rss-live test runs it for
 * real), so `feedItems` stands in for plugin_rss.feed_item: it answers the
 * job's two statements and nothing else.
 */

const FEED_URL = 'https://northwind-robotics.example/news/feed.xml'
const RECORD = '0b5cbe3e-7a4e-4f7e-9b44-3f1c2a9d8e01'
const rss2 = readFileSync(
  new URL('../fixtures/rss2.xml', import.meta.url),
  'utf8',
)
const atom = readFileSync(
  new URL('../fixtures/atom.xml', import.meta.url),
  'utf8',
)

const feedItems = (recorder: Recorder) => {
  const rows = new Map<string, { signalId: string | null }>()
  const keyOf = (params: ReadonlyArray<JsonValue>) =>
    JSON.stringify(params.slice(0, 3))
  const query = (
    sql: string,
    params: ReadonlyArray<JsonValue> = [],
  ): ReadonlyArray<JsonObject> => {
    const key = keyOf(params)
    if (sql === UPSERT_ITEM) {
      const row = rows.get(key) ?? { signalId: null }
      rows.set(key, row)
      return [{ signal_id: row.signalId }]
    }
    if (sql === MARK_EMITTED) {
      const signalId = params.at(3)
      if (typeof signalId !== 'string') throw new Error('no signal id')
      rows.set(key, { signalId })
      return []
    }
    throw new Error(`unexpected statement: ${sql}`)
  }
  const layer = Layer.succeed(PluginDb, {
    query: (sql, params) =>
      Effect.sync(() => {
        const out = query(sql, params)
        recorder.record({
          port: 'PluginDb',
          method: 'query',
          input: sql === UPSERT_ITEM ? 'upsert' : 'mark',
          output: out,
        })
        return out
      }),
  })
  return { layer, rows }
}

const CONFIG: JsonObject = { feedUrl: FEED_URL, record: RECORD }

const ports = (
  body: string,
  options: { readonly status?: number; readonly config?: JsonObject } = {},
) => {
  const recorder = makeRecorder()
  const script: ReadonlyArray<HttpScript> = [
    {
      url: FEED_URL,
      response: { status: options.status ?? 200, body },
      repeat: true,
    },
  ]
  const db = feedItems(recorder)
  const content = ContentTest({ recorder })
  const log = LogTest({ recorder })
  const facts = FactsTest({ recorder })
  const identity = IdentityTest({ recorder })
  return {
    recorder,
    db,
    content,
    log,
    facts,
    identity,
    // The five ports `uses` grants, plus Facts and Identity to show the job
    // never reaches for them even when they are there.
    layer: Layer.mergeAll(
      ConfigTest(options.config ?? CONFIG, { recorder }).layer,
      HttpTest(script, { recorder }).layer,
      db.layer,
      content.layer,
      log.layer,
      facts.layer,
      identity.layer,
    ),
  }
}

type Ports = ReturnType<typeof ports>

const poll = (p: Ports) =>
  Effect.runPromise(
    plugin.jobs.poll({ cursor: null }).pipe(Effect.provide(p.layer)),
  )

/** The job's failure, or null when it succeeded. */
const failure = async (p: Ports) => {
  const exit = await Effect.runPromiseExit(
    plugin.jobs.poll({ cursor: null }).pipe(Effect.provide(p.layer)),
  )
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
}

const emitted = (p: Ports) =>
  p.content.calls.filter((c) => c.method === 'emitSignal')

describe('the rss poll job, on the test Layers', () => {
  it('emits each item once, oldest first, on the configured record', async () => {
    const p = ports(rss2)
    expect(await poll(p)).toEqual({ nextCursor: null })
    expect(emitted(p).map((c) => c.input)).toEqual([
      {
        _tag: 'signal',
        entityId: RECORD,
        kind: SIGNAL_KIND,
        title: 'Northwind at RoboConf 2026',
        url: 'https://northwind-robotics.example/news/roboconf',
        publishedAt: '2026-09-01T10:00:00.000Z',
        payload: {
          feedUrl: FEED_URL,
          itemKey: 'northwind-news-0001',
          feedTitle: 'Northwind Robotics — Newsroom',
        },
      },
      expect.objectContaining({
        title: 'Pilot with a regional grocer — phase two',
      }),
      expect.objectContaining({
        title: 'Hiring: 3 field engineers for the R&D lab',
      }),
      expect.objectContaining({
        title: 'Northwind closes its Series B',
        payload: expect.objectContaining({
          summary: 'Northwind raised $40M led by Example Ventures & friends.',
        }),
      }),
    ])
    expect([...p.db.rows.values()].map((r) => r.signalId)).toEqual([
      'signal-1',
      'signal-2',
      'signal-3',
      'signal-4',
    ])
  })

  it('a second poll of the same feed emits nothing', async () => {
    const p = ports(rss2)
    await poll(p)
    await poll(p)
    expect(emitted(p)).toHaveLength(4)
    expect(p.log.lines.map((l) => l.fields)).toEqual([
      { feedUrl: FEED_URL, format: 'rss', items: 4, emitted: 4 },
      { feedUrl: FEED_URL, format: 'rss', items: 4, emitted: 0 },
    ])
  })

  it('reads Atom the same way', async () => {
    const p = ports(atom)
    await poll(p)
    expect(emitted(p).map((c) => c.input)).toMatchObject([
      { title: 'Notes from our seed round' },
      { title: 'Contoso Labs opens a Berlin office' },
      { title: 'Shipping v2 of the inference engine' },
    ])
  })

  it('reads only maxItems, the newest', async () => {
    const p = ports(rss2, { config: { ...CONFIG, maxItems: 2 } })
    await poll(p)
    expect(emitted(p).map((c) => c.input)).toMatchObject([
      { title: 'Hiring: 3 field engineers for the R&D lab' },
      { title: 'Northwind closes its Series B' },
    ])
  })

  it('calls Config, Http, PluginDb, Content and Log, and never Facts or Identity', async () => {
    const p = ports(rss2)
    await poll(p)
    expect(new Set(p.recorder.calls.map((c) => c.port))).toEqual(
      new Set(['Config', 'Http', 'PluginDb', 'Content', 'Log']),
    )
    expect(p.facts.calls).toEqual([])
    expect(p.identity.calls).toEqual([])
  })

  it('fails retryable on a 5xx and permanent on a 4xx or a body that is no feed', async () => {
    expect(await failure(ports('', { status: 503 }))).toBeInstanceOf(
      JobRetryable,
    )
    const notFound = await failure(ports('', { status: 404 }))
    expect(notFound).toBeInstanceOf(JobPermanent)
    expect(notFound).toMatchObject({ reason: `${FEED_URL} answered 404` })
    expect(await failure(ports('<html></html>'))).toMatchObject({
      reason: `${FEED_URL} is not an RSS or Atom feed`,
    })
  })

  it('refuses a config with no record before fetching anything', async () => {
    const p = ports(rss2, { config: { feedUrl: FEED_URL } })
    expect(await failure(p)).toBeInstanceOf(JobPermanent)
    expect(p.recorder.calls.map((c) => c.port)).toEqual(['Config'])
  })
})
