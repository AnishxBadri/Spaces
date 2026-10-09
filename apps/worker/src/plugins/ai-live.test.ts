import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit, Layer, Option } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@spaces/db'
import {
  aiRoute,
  aiUsage,
  entity,
  entitySpace,
  integration,
  jobRun,
  signal,
  space,
  suggestion,
  workspace,
} from '@spaces/db/schema'
import type { AiCapsSetting } from '@spaces/db/schema/workspace'
import { Enqueue } from '@spaces/core/queue/enqueue'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { ModelCall } from '@spaces/core/writes/ports/ai'
import { JobPermanent } from '@spaces/sdk'
import { pgBossHost } from '../run-job'
import { makePluginHost } from './host'
import type { PluginHost } from './host'
import { reconcilePlugins } from './loader'
import { ModelCallLive } from './model-call'

/**
 * The Ai port live, through the loader, against the test database and an
 * injected model: the route, the sensitivity gate, the cap and the
 * `ai_usage` row are real, and nothing reaches a network. The fixtures are
 * the built researcher, overreach (its `enrich` job), poller and
 * gatecrasher bundles.
 */

const fixtures = fileURLToPath(
  new URL('../../../../plugins/_fixtures/', import.meta.url),
)
const SEARCH_URL = 'https://search.example/v1/search'
const search = readFileSync(
  path.join(fixtures, 'researcher/fixtures/search.json'),
  'utf8',
)

const newPluginsRoot = () => {
  const root = path.join(
    mkdtempSync(path.join(tmpdir(), 'spaces-ai-live-')),
    'plugins',
  )
  mkdirSync(root, { recursive: true })
  return root
}

const install = (root: string, fixture: string) => {
  const dir = path.join(root, fixture, 'current')
  mkdirSync(dir, { recursive: true })
  for (const file of ['bundle.mjs', 'manifest.json'])
    cpSync(path.join(fixtures, fixture, 'dist', file), path.join(dir, file))
}

const row = async (capabilityId: string) => {
  const inserted = (
    await db
      .insert(integration)
      .values({ capabilityId, version: '0.1.0', enabled: true })
      .returning()
  ).at(0)
  if (!inserted) throw new Error('no integration row')
  return inserted
}

const fakeFetch = (url: string) =>
  Promise.resolve(
    url === SEARCH_URL
      ? new Response(search, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response('not found', { status: 404 }),
  )

/** Answers JSON when the call asks for an object, a cited brief otherwise. */
const mockModel = () =>
  new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text:
              options.responseFormat?.type === 'json'
                ? JSON.stringify({ topic: 'funding' })
                : 'Northwind raised a seed round [event:hit-1].',
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 40,
            noCache: 40,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      }),
  })

/** `complete()` over the mock, counting each AiLive built on it and each call. */
const countedModelCall = (model: MockLanguageModelV4) => {
  const counts = { built: 0, calls: 0 }
  const layer = Layer.effect(
    ModelCall,
    Effect.gen(function* () {
      counts.built += 1
      const inner = yield* ModelCall
      return ModelCall.of({
        complete: (input) =>
          Effect.suspend(() => {
            counts.calls += 1
            return inner.complete(input)
          }),
      })
    }),
  ).pipe(Layer.provide(ModelCallLive({ model })))
  return { counts, layer }
}

const noEnqueue = Layer.succeed(
  Enqueue,
  Enqueue.of({ enqueue: () => Effect.succeed(null) }),
)

const hosts: Array<PluginHost> = []

const boot = async (root: string, options: { readonly boss?: PgBoss } = {}) => {
  const model = mockModel()
  const modelCall = countedModelCall(model)
  const host = makePluginHost({
    enqueue: noEnqueue,
    fetch: fakeFetch,
    sink: () => undefined,
    modelCall: modelCall.layer,
    ...(options.boss === undefined
      ? {}
      : {
          queues: {
            boss: options.boss,
            host: pgBossHost(options.boss),
            pollingIntervalSeconds: 0.5,
          },
        }),
  })
  hosts.push(host)
  const reconciled = await Effect.runPromise(
    reconcilePlugins({ pluginsRoot: root }),
  )
  const wired = await Effect.runPromise(host.wire(reconciled.loaded))
  return { host, model, calls: modelCall.counts, wired }
}

const route = (
  lane: 'classify' | 'synthesize',
  sensitivity: 'normal' | 'sensitive',
  provider = 'anthropic',
) =>
  db.insert(aiRoute).values({
    lane,
    sensitivity,
    provider,
    model: provider === 'ollama' ? 'llama3.2' : 'claude-haiku-4-5',
  })

/** A fresh company: each test's own domain, so none attaches to another's record. */
const seedCompany = async () => {
  const tag = Math.random().toString(36).slice(2, 8)
  return (
    await resolveEntity({
      kind: 'company',
      name: 'Northwind Robotics',
      keys: { domain: `northwind-${tag}.example` },
      source: { class: 'manual' },
    })
  ).entityId
}

/** A sensitive space, with `companyId` filed under it. */
const fileUnderSensitiveSpace = async (companyId: string, name: string) => {
  const created = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name, sensitive: true })
      .returning({ id: entity.id })
  ).at(0)
  if (!created) throw new Error('no space entity')
  const slug = `vault_${Math.random().toString(36).slice(2, 8)}`
  await db
    .insert(space)
    .values({ entityId: created.id, parentId: null, slug, path: slug })
  await db
    .insert(entitySpace)
    .values({ entityId: companyId, spaceId: created.id, source: 'manual' })
}

/** Row counts of every table in `public`. */
const counts = async () => {
  const tables = (
    await db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables where schemaname = 'public' order by tablename`,
    )
  ).rows
  const out: Record<string, number> = {}
  for (const { name } of tables) {
    const counted = (
      await db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(name)}`,
      )
    ).rows.at(0)
    out[name] = counted?.n ?? -1
  }
  return out
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.findErrorOption(exit.cause))
    : null

const reasonOf = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failureOf(exit)
  return error instanceof JobPermanent ? error.reason : null
}

/** Sets `workspace.settings.ai_caps`, creating the singleton if absent. */
const capAt = async (aiCaps: AiCapsSetting) => {
  const settings = { ai_caps: aiCaps }
  await db
    .insert(workspace)
    .values({ id: 1, name: 'Fund', settings })
    .onConflictDoUpdate({ target: workspace.id, set: { settings } })
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await Effect.runPromise(host.releaseAll())
  await db
    .update(integration)
    .set({ enabled: false })
    .where(isNotNull(integration.id))
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(aiUsage).where(isNotNull(aiUsage.id))
  await db.delete(workspace).where(eq(workspace.id, 1))
})

describe('a researcher', () => {
  it('gets Ai, and its usage is attributed to the integration', async () => {
    await route('synthesize', 'normal')
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'researcher')
    const researcher = await row('researcher')
    const { host, model } = await boot(root)
    expect(host.granted(researcher.id, 'research')).toEqual([
      'Ai',
      'Content',
      'Http',
      'Judgment',
      'Log',
      'Read',
    ])

    const exit = await Effect.runPromiseExit(
      host.invoke(researcher.id, 'research', { entityId: companyId }),
    )
    expect(exit._tag).toBe('Success')
    expect(model.doGenerateCalls).toHaveLength(1)

    const usage = await db.select().from(aiUsage)
    expect(usage).toHaveLength(1)
    expect(usage.at(0)).toMatchObject({
      lane: 'synthesize',
      provider: 'anthropic',
      callerType: 'integration',
      callerId: researcher.id,
      tokensIn: 40,
      tokensOut: 10,
    })
    // The claim lands: the brief, citing the signal its hit became.
    const signals = await db
      .select({ id: signal.id })
      .from(signal)
      .where(eq(signal.entityId, companyId))
    expect(signals).toHaveLength(3)
    const proposed = await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.entityId, companyId))
    expect(proposed).toHaveLength(1)
    expect(proposed.at(0)).toMatchObject({
      kind: 'note',
      proposedByType: 'integration',
      proposedById: researcher.id,
    })
    expect(JSON.stringify(proposed.at(0)?.payload)).toMatch(
      /raised a seed round \[event:[0-9a-f-]{36}\]/,
    )
  })

  it('builds one AiLive per (integration, job) and reuses it across invocations', async () => {
    await route('synthesize', 'normal')
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'researcher')
    const researcher = await row('researcher')
    const { host, calls } = await boot(root)
    expect(calls.built).toBe(1)

    for (let i = 0; i < 2; i++) {
      const exit = await Effect.runPromiseExit(
        host.invoke(researcher.id, 'research', { entityId: companyId }),
      )
      expect(exit._tag).toBe('Success')
    }
    expect(calls).toEqual({ built: 1, calls: 2 })
  })

  it('on a record under a sensitive space, refuses by name with the lane routed to the cloud, and writes nothing', async () => {
    await route('synthesize', 'normal')
    await route('synthesize', 'sensitive')
    const companyId = await seedCompany()
    await fileUnderSensitiveSpace(companyId, 'Project Vault')
    const root = newPluginsRoot()
    install(root, 'researcher')
    const researcher = await row('researcher')
    const { host, model } = await boot(root)

    const before = await counts()
    const exit = await Effect.runPromiseExit(
      host.invoke(researcher.id, 'research', { entityId: companyId }),
    )
    expect(reasonOf(exit)).toBe(
      'SensitiveRouteRefused: Sensitive material is not sent to Anthropic (sensitivity inherited from Project Vault); route the synthesize lane to a local model',
    )
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await counts()).toEqual(before)
  })
})

describe('an enricher', () => {
  it('that yields Ai it never declared fails service-not-found, with no provider call', async () => {
    await route('synthesize', 'normal')
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'overreach')
    const overreach = await row('overreach')
    const { host, model, calls } = await boot(root)
    expect(host.granted(overreach.id, 'enrich')).toEqual([
      'Facts',
      'Log',
      'Read',
    ])

    const before = await counts()
    const exit = await Effect.runPromiseExit(
      host.invoke(overreach.id, 'enrich', { entityId: companyId }),
    )
    expect(reasonOf(exit)).toBe(
      'overreach.enrich used Ai, which its manifest does not grant it: Service not found: spaces/sdk/Ai',
    )
    expect(calls).toEqual({ built: 0, calls: 0 })
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await counts()).toEqual(before)
  })
})

describe('a poller', () => {
  it('classifies, and its call to synthesize fails at the port before any model', async () => {
    await route('classify', 'normal')
    await route('synthesize', 'normal')
    const root = newPluginsRoot()
    install(root, 'poller')
    const poller = await row('poller')
    const { host, model, calls } = await boot(root)

    const classified = await Effect.runPromiseExit(
      host.invoke(poller.id, 'classify', { cursor: null }),
    )
    expect(classified).toEqual(Exit.succeed({ nextCursor: null }))
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(
      await db
        .select({ lane: aiUsage.lane, callerId: aiUsage.callerId })
        .from(aiUsage),
    ).toEqual([{ lane: 'classify', callerId: poller.id }])

    const briefed = await Effect.runPromiseExit(
      host.invoke(poller.id, 'brief', { cursor: null }),
    )
    expect(reasonOf(briefed)).toBe(
      'Ai.complete: a schedule job may call the classify lane only, not synthesize',
    )
    // Refused by the port: the model call was never made.
    expect(calls.calls).toBe(1)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(await db.select().from(aiUsage)).toHaveLength(1)
  })
})

describe('the sensitivity gate', () => {
  it('ignores what the plugin passes: a sensitive record refuses whatever its items claim', async () => {
    await route('synthesize', 'normal')
    await route('synthesize', 'sensitive')
    const companyId = await seedCompany()
    await db
      .update(entity)
      .set({ sensitive: true })
      .where(eq(entity.id, companyId))
    const root = newPluginsRoot()
    install(root, 'gatecrasher')
    const gatecrasher = await row('gatecrasher')
    const { host, model } = await boot(root)

    const before = await counts()
    const exit = await Effect.runPromiseExit(
      host.invoke(gatecrasher.id, 'research', { entityId: companyId }),
    )
    expect(reasonOf(exit)).toBe(
      'SensitiveRouteRefused: Sensitive material is not sent to Anthropic; route the synthesize lane to a local model',
    )
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(await counts()).toEqual(before)
  })

  it('on a normal record the call runs, and the caller is the integration whatever the items name', async () => {
    await route('synthesize', 'normal')
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'gatecrasher')
    const gatecrasher = await row('gatecrasher')
    const { host } = await boot(root)

    const exit = await Effect.runPromiseExit(
      host.invoke(gatecrasher.id, 'research', { entityId: companyId }),
    )
    expect(exit._tag).toBe('Success')
    expect(
      await db
        .select({ type: aiUsage.callerType, id: aiUsage.callerId })
        .from(aiUsage),
    ).toEqual([{ type: 'integration', id: gatecrasher.id }])
  })

  it('a sensitive record routed to a local model runs', async () => {
    await route('synthesize', 'sensitive', 'ollama')
    const companyId = await seedCompany()
    await db
      .update(entity)
      .set({ sensitive: true })
      .where(eq(entity.id, companyId))
    const root = newPluginsRoot()
    install(root, 'gatecrasher')
    const gatecrasher = await row('gatecrasher')
    const { host } = await boot(root)

    const exit = await Effect.runPromiseExit(
      host.invoke(gatecrasher.id, 'research', { entityId: companyId }),
    )
    expect(exit._tag).toBe('Success')
    expect(
      await db
        .select({ provider: aiUsage.provider, lane: aiUsage.lane })
        .from(aiUsage),
    ).toEqual([{ provider: 'ollama', lane: 'synthesize' }])
  })
})

describe('the per-day ceiling', () => {
  let boss: PgBoss

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL
    if (connectionString === undefined) throw new Error('DATABASE_URL is unset')
    boss = new PgBoss({
      connectionString,
      schema: 'pgboss',
      schedule: false,
      supervise: false,
    })
    boss.on('error', (error: Error) => console.error('[pg-boss]', error))
    await boss.start()
    for (const queue of await boss.getQueues())
      if (queue.name.startsWith('plugin.')) await boss.deleteQueue(queue.name)
  })

  afterAll(async () => {
    await boss.stop({ graceful: false })
  })

  it("refuses a researcher's call with CapExceeded once the day is spent, and closes job_run with the reason", async () => {
    await route('synthesize', 'normal')
    await capAt({ daily_tokens: 50 })
    await db.insert(aiUsage).values({
      lane: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      tokensIn: 40,
      tokensOut: 10,
      callerType: 'system',
    })
    const companyId = await seedCompany()
    const root = newPluginsRoot()
    install(root, 'researcher')
    const researcher = await row('researcher')
    const { model, wired } = await boot(root, { boss })
    expect(wired.map((v) => v.status)).toEqual(['enabled'])

    const queue = 'plugin.researcher.research'
    await boss.send(queue, { entityId: companyId })
    const until = Date.now() + 15_000
    let runs = await db
      .select()
      .from(jobRun)
      .where(
        and(eq(jobRun.queue, queue), eq(jobRun.integrationId, researcher.id)),
      )
    while (
      (runs.length === 0 || runs.some((r) => r.status === 'running')) &&
      Date.now() < until
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      runs = await db
        .select()
        .from(jobRun)
        .where(
          and(eq(jobRun.queue, queue), eq(jobRun.integrationId, researcher.id)),
        )
    }
    expect(runs.map((r) => [r.status, r.error])).toEqual([
      [
        'failed',
        "permanent: CapExceeded: Today's AI cap of 50 tokens is reached; resets at 00:00 UTC",
      ],
    ])
    expect(model.doGenerateCalls).toHaveLength(0)
    // Nothing beyond the human's spend, and no signal from the refused run.
    expect(await db.select().from(aiUsage)).toHaveLength(1)
    expect(
      await db.select().from(signal).where(eq(signal.entityId, companyId)),
    ).toEqual([])
  })
})
