import { Effect } from 'effect'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import {
  aiUsage,
  askTurn,
  credential,
  enrichmentRecord,
  entity,
  entitySpace,
  integration,
  space,
  spaceWatch,
  spaceWatchDismissal,
  suggestion,
} from '@spaces/db/schema'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { discoverWith } from '@spaces/core/writes/ports/discover'
import { storeCredential } from '@spaces/core/writes/vault'
import { openRunProgram } from '#/lib/ai/run'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { setAiRouteProgram } from '#/lib/ai/route'
import {
  addFindRowProgram,
  dismissFindRowProgram,
  fileFindRowProgram,
} from './find'
import {
  clearToolLists,
  mountProgram,
  mountablesProgram,
  webSourcesProgram,
} from './mount'
import { askEvents } from './turn'
import {
  getThreadProgram,
  threadTurnsProgram,
  turnViewsProgram,
} from './threads'
import type { AskEvent, AskFindTable, AskScopeChip } from './types'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Find in Ask against the test database and a fake MCP server: the plugin's
 * server mounted from its integration row, its tools in the call strip with
 * the integration, the sensitive unmount, the credit cap, the results table
 * read through Discover, and Add / File here / Dismiss.
 */

const run = <TValue, TError>(e: Effect.Effect<TValue, TError>) =>
  Effect.runPromise(e)

const KEY = 'exa-test-key-0123456789'

const usage = {
  inputTokens: {
    total: 30,
    noCache: 30,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 7, text: 7, reasoning: undefined },
}

type Step =
  | { kind: 'call'; toolName: string; input: unknown }
  | { kind: 'text'; text: string }

/** A model that takes `steps` in order, one per round; it records the tools it was offered. */
function scriptedModel(steps: ReadonlyArray<Step>) {
  const offered: Array<Array<string>> = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (options) => {
      offered.push((options.tools ?? []).map((t) => t.name))
      const round = options.prompt.filter((m) => m.role === 'tool').length
      const step = steps.at(Math.min(round, steps.length - 1))
      if (step === undefined || step.kind === 'text')
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start' as const, id: 't' },
              {
                type: 'text-delta' as const,
                id: 't',
                delta: step?.text ?? '',
              },
              { type: 'text-end' as const, id: 't' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage,
              },
            ],
          }),
        }
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call' as const,
              toolCallId: `call-${String(round)}`,
              toolName: step.toolName,
              input: JSON.stringify(step.input),
            },
            {
              type: 'finish' as const,
              finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
              usage,
            },
          ],
        }),
      }
    },
  })
  return { model, offered }
}

/** The world one test searches: its own domains, so tests share no record. */
const domainsOf = (t: string) => ({
  leasewise: `leasewise${t}.example`,
  keyhold: `keyhold${t}.example`,
  nova: `novarentals${t}.example`,
  gone: `gonehomes${t}.example`,
  ghost: `ghost${t}.example`,
})

const searchText = (t: string) => {
  const d = domainsOf(t)
  return [
    'Title: Leasewise — rent collection for landlords',
    `URL: https://${d.leasewise}/about`,
    'Title: Keyhold raises seed',
    `URL: https://news.example/${d.keyhold}-seed`,
    'Title: Nova Rentals',
    `URL: https://${d.nova}/`,
    'Title: Gone Homes',
    `URL: https://${d.gone}/`,
  ].join('\n')
}

type Seen = { method: string; headers: Record<string, string> }

/** A fake MCP server: initialize, tools/list, tools/call over JSON and SSE. */
function fakeMcp(t: string, opts: { isError?: boolean } = {}) {
  const seen: Array<Seen> = []
  const fetch = vi.fn(
    async (
      _url: string,
      init: { method: string; headers: Record<string, string>; body?: unknown },
    ) => {
      const body: unknown =
        typeof init.body === 'string' ? JSON.parse(init.body) : null
      const msg =
        typeof body === 'object' && body !== null && !Array.isArray(body)
          ? new Map(Object.entries(body))
          : new Map<string, unknown>()
      const method = String(msg.get('method'))
      seen.push({ method, headers: init.headers })
      const id = msg.get('id')
      const json = (result: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json', ...headers },
        })
      if (method === 'initialize')
        return json(
          { protocolVersion: '2025-06-18', capabilities: {} },
          { 'mcp-session-id': 'session-1' },
        )
      if (method === 'notifications/initialized')
        return new Response(null, { status: 202 })
      if (method === 'tools/list')
        return json({
          tools: [
            {
              name: 'web_search_exa',
              description: 'Search the web',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
          ],
        })
      // tools/call answers as an event stream.
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text:
                  opts.isError === true ? 'Exa: rate limited' : searchText(t),
              },
            ],
            ...(opts.isError === true ? { isError: true } : {}),
          },
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  )
  return { fetch, seen }
}

let n = 0
const tag = () => `${String(++n)}${Math.random().toString(36).slice(2, 6)}`

async function aSpace(name: string, sensitive = false) {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'space', canonicalName: name, sensitive })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no space')
  const slug = `f${tag()}`
  await db
    .insert(space)
    .values({ entityId: ent.id, parentId: null, slug, path: slug })
  return ent.id
}

const aCompany = async (name: string, domain: string) =>
  (
    await resolveEntity({
      kind: 'company',
      name,
      keys: { domain },
      source: { class: 'manual' },
    })
  ).entityId

async function anExa(
  opts: { enabled?: boolean; config?: Record<string, number> } = {},
) {
  const { id: credentialId } = await storeCredential({
    scope: 'workspace',
    provider: 'exa',
    kind: 'search',
    secret: KEY,
    createdBy: FIXTURE_ACTOR.id,
  })
  const row = (
    await db
      .insert(integration)
      .values({
        capabilityId: 'exa',
        version: '0.1.0',
        enabled: opts.enabled ?? true,
        status: opts.enabled === false ? 'disabled' : 'enabled',
        config: opts.config ?? {},
        credentialId,
        manifest: {
          manifestVersion: 1,
          id: 'exa',
          version: '0.1.0',
          sdk: '^1.4',
          name: 'Exa',
          description: 'Web search.',
          requires: { credential: { kind: 'search', scope: 'workspace' } },
          settings: { type: 'object', properties: {} },
          jobs: { research: { trigger: 'action', uses: ['Http'] } },
          mcp: {
            url: 'https://mcp.exa.test/mcp?tools=web_search_exa',
            auth: { header: 'x-api-key' },
          },
        },
      })
      .returning({ id: integration.id })
  ).at(0)
  if (!row) throw new Error('no integration')
  return row.id
}

const WEB: AskScopeChip = { kind: 'web', id: null, name: 'Web', href: null }
const chip = (id: string, name: string): AskScopeChip => ({
  kind: 'space',
  id,
  name,
  href: `/spaces/${id}`,
})

const findSteps = (t: string): ReadonlyArray<Step> => {
  const d = domainsOf(t)
  return [
    {
      kind: 'call',
      toolName: 'exa__web_search_exa',
      input: { query: 'rental software startups in India' },
    },
    {
      kind: 'call',
      toolName: 'show_companies',
      input: {
        companies: [
          {
            name: 'Leasewise',
            domain: d.leasewise,
            line: 'Rent collection for landlords',
            place: 'Bengaluru',
            // Repeated: the row cites the page once.
            sources: [
              `https://${d.leasewise}/about`,
              `https://${d.leasewise}/about`,
            ],
          },
          {
            name: 'Keyhold',
            domain: d.keyhold,
            line: 'Tenant screening',
            place: 'Mumbai',
            sources: [`https://news.example/${d.keyhold}-seed`],
          },
          {
            name: 'Nova Rentals',
            domain: d.nova,
            line: 'Furnished rentals',
            place: null,
            sources: [`https://${d.nova}/`],
          },
          {
            name: 'Gone Homes',
            domain: d.gone,
            line: 'Dismissed before',
            place: null,
            sources: [`https://${d.gone}/`],
          },
          {
            name: 'Ghost Co',
            domain: d.ghost,
            line: 'Never returned by a search',
            place: null,
            sources: [`https://${d.ghost}/`],
          },
        ],
      },
    },
    { kind: 'text', text: 'Three operators turned up; one is already here.' },
  ]
}

async function collect(events: AsyncIterable<AskEvent>) {
  const out: Array<AskEvent> = []
  for await (const e of events) out.push(e)
  return out
}

const endOf = (events: ReadonlyArray<AskEvent>) => {
  const last = events.at(-1)
  if (last?.type !== 'end') throw new Error('the turn did not end')
  return last.turn
}

const tableOf = (calls: ReadonlyArray<{ find?: AskFindTable }>) => {
  const table = calls.find((c) => c.find !== undefined)?.find
  if (table === undefined) throw new Error('no find table')
  return table
}

/** Property ops: Leasewise filed here, Keyhold held elsewhere, Gone dismissed. */
async function propertyOps(t: string) {
  const d = domainsOf(t)
  const ops = await aSpace('Property ops')
  const elsewhere = await aSpace('Proptech')
  const leasewise = await aCompany('Leasewise', d.leasewise)
  await db.insert(entitySpace).values({ entityId: leasewise, spaceId: ops })
  const keyhold = await aCompany('Keyhold', d.keyhold)
  await db.insert(entitySpace).values({ entityId: keyhold, spaceId: elsewhere })
  await db.insert(spaceWatchDismissal).values({
    spaceId: ops,
    domain: d.gone,
    dismissedBy: FIXTURE_ACTOR.id,
  })
  return { ops, leasewise, keyhold, d }
}

beforeEach(async () => {
  clearToolLists()
  // A test's integration is the only one running.
  await db
    .update(integration)
    .set({ enabled: false, status: 'disabled' })
    .where(eq(integration.enabled, true))
  await run(
    setAiRouteProgram({
      lane: 'synthesize',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-opus-5',
    }),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a plugin MCP server mounted in Ask', () => {
  it('mounts an enabled integration’s tools, keyed from the vault, and answers a find as a table read through Discover', async () => {
    const t = tag()
    const exa = await anExa()
    const { ops, leasewise, keyhold, d } = await propertyOps(t)
    const { fetch, seen } = fakeMcp(t)
    const { model, offered } = scriptedModel(findSteps(t))
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Rental software startups in India',
        scope: [chip(ops, 'Property ops'), WEB],
        model,
        pluginFetch: fetch,
      }),
    )
    const turn = endOf(events)
    expect(turn.state).toBe('answered')
    expect(offered.at(0)).toEqual(
      expect.arrayContaining(['exa__web_search_exa', 'show_companies']),
    )

    // The strip: the plugin's tool with the integration it went through.
    expect(turn.calls).toContainEqual({
      tool: 'web_search_exa',
      state: 'done',
      input: '“rental software startups in India”',
      found: 4,
      via: { integrationId: exa, name: 'Exa' },
    })

    // The key went in its header on every request, and never anywhere else.
    expect(seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ])
    expect(seen.every((s) => s.headers['x-api-key'] === KEY)).toBe(true)
    expect(seen.at(-1)?.headers['mcp-session-id']).toBe('session-1')
    const stored = await db
      .select({ calls: askTurn.calls, body: askTurn.bodyMd })
      .from(askTurn)
      .where(eq(askTurn.id, turn.id))
    expect(JSON.stringify(stored)).not.toContain(KEY)

    // The table: filed greyed, held offers File here, unknown Add, the
    // dismissed domain hidden and counted, the unsourced row left out.
    const table = tableOf(turn.calls)
    expect(table.space).toEqual({ id: ops, name: 'Property ops' })
    expect(table.hidden).toBe(1)
    expect(
      table.rows.map((r) => [r.domain, r.standing, r.entityId, r.via.name]),
    ).toEqual([
      [d.leasewise, 'filed', leasewise, 'Exa'],
      [d.keyhold, 'held', keyhold, 'Exa'],
      [d.nova, 'unknown', null, 'Exa'],
    ])

    expect(table.rows.at(0)?.sources).toEqual([
      { url: `https://${d.leasewise}/about` },
    ])

    // ai_usage carries the plugin call as the integration's, under the
    // turn's run; spend is one receipt.
    const runId = (
      await db
        .select({ runId: askTurn.aiRunId })
        .from(askTurn)
        .where(eq(askTurn.id, turn.id))
    ).at(0)?.runId
    const pluginUsage = await db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.callerId, exa))
    expect(pluginUsage).toHaveLength(1)
    expect(pluginUsage.at(0)).toMatchObject({
      callerId: exa,
      runId,
      provider: 'exa',
      model: 'web_search_exa',
      lane: 'research',
    })
    const receipts = await db
      .select()
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, exa))
    expect(receipts.map((r) => [r.entityId, r.creditsUsed])).toEqual([
      [null, 1],
    ])
  })

  it('offers no plugin tool when the integration is disabled, and makes no request', async () => {
    await anExa({ enabled: false })
    const { fetch } = fakeMcp(tag())
    const { model, offered } = scriptedModel([{ kind: 'text', text: 'Hi.' }])
    await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Anything?',
        scope: [WEB],
        model,
        pluginFetch: fetch,
      }),
    )
    expect(offered.flat()).not.toContain('exa__web_search_exa')
    expect(offered.flat()).not.toContain('show_companies')
    expect(fetch).not.toHaveBeenCalled()
    expect(await run(webSourcesProgram())).toEqual([])
  })

  it('mounts nothing without the web chip', async () => {
    await anExa()
    const { fetch } = fakeMcp(tag())
    const { model, offered } = scriptedModel([{ kind: 'text', text: 'Hi.' }])
    await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Anything?',
        scope: [],
        model,
        pluginFetch: fetch,
      }),
    )
    expect(offered.flat()).not.toContain('exa__web_search_exa')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('unmounts every plugin server for a sensitive scope before any call: the cell reads unmounted, the server sees nothing', async () => {
    await run(
      setAiRouteProgram({
        lane: 'synthesize',
        sensitivity: 'sensitive',
        provider: 'ollama',
        model: 'llama3.2',
      }),
    )
    const exa = await anExa()
    const fund = await aSpace('Fund II', true)
    const t = tag()
    const { fetch } = fakeMcp(t)
    const { model, offered } = scriptedModel(findSteps(t))
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Rental software startups in India',
          scope: [chip(fund, 'Fund II'), WEB],
          model,
          pluginFetch: fetch,
        }),
      ),
    )
    expect(fetch).toHaveBeenCalledTimes(0)
    expect(offered.flat()).not.toContain('exa__web_search_exa')
    expect(offered.flat()).not.toContain('show_companies')
    expect(turn.calls).toContainEqual({
      tool: 'web',
      state: 'unmounted',
      input: '',
      found: null,
      via: { integrationId: exa, name: 'Exa' },
      reason: 'Sensitive material never reaches Exa',
    })
    expect(
      (
        await db
          .select({ n: count() })
          .from(aiUsage)
          .where(eq(aiUsage.callerId, exa))
      ).at(0)?.n,
    ).toBe(0)
  })

  it('refuses a call over the daily credit cap with the cap, before the tool is called', async () => {
    const exa = await anExa({ config: { dailyCreditCap: 1 } })
    await db.insert(enrichmentRecord).values({
      entityId: null,
      provider: 'exa',
      raw: {},
      creditsUsed: 1,
      integrationId: exa,
    })
    const t = tag()
    const { fetch, seen } = fakeMcp(t)
    const { model } = scriptedModel([
      findSteps(t)[0],
      { kind: 'text', text: 'The search was refused.' },
    ])
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Rental software startups in India',
          scope: [WEB],
          model,
          pluginFetch: fetch,
        }),
      ),
    )
    expect(seen.map((s) => s.method)).not.toContain('tools/call')
    expect(turn.calls).toContainEqual({
      tool: 'web_search_exa',
      state: 'refused',
      input: '“rental software startups in India”',
      found: null,
      via: { integrationId: exa, name: 'Exa' },
      reason: 'daily credit cap (1) reached',
    })
  })
})

describe('a mount that goes wrong', () => {
  it('settles the turn when the key cannot be decrypted: the cell reads unmounted, the server sees nothing', async () => {
    const exa = await anExa()
    await db
      .update(credential)
      .set({ secretEnc: Buffer.from([9, 9, 9]) })
      .where(eq(credential.provider, 'exa'))
    const t = tag()
    const { fetch } = fakeMcp(t)
    const { model, offered } = scriptedModel([{ kind: 'text', text: 'Hi.' }])
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Rental software startups in India',
          scope: [WEB],
          model,
          pluginFetch: fetch,
        }),
      ),
    )
    expect(turn.state).toBe('answered')
    expect(fetch).not.toHaveBeenCalled()
    expect(offered.flat()).not.toContain('exa__web_search_exa')
    expect(turn.calls).toContainEqual({
      tool: 'web',
      state: 'unmounted',
      input: '',
      found: null,
      via: { integrationId: exa, name: 'Exa' },
      reason: 'Exa: its key could not be read',
    })
  })

  it('shows the model’s text when the only search failed, never "Nothing found"', async () => {
    await anExa()
    const t = tag()
    const { fetch } = fakeMcp(t, { isError: true })
    const { model } = scriptedModel([
      findSteps(t)[0],
      { kind: 'text', text: 'The web search failed; try again shortly.' },
    ])
    const turn = endOf(
      await collect(
        askEvents({
          userId: FIXTURE_ACTOR.id,
          threadId: null,
          question: 'Rental software startups in India',
          scope: [WEB],
          model,
          pluginFetch: fetch,
        }),
      ),
    )
    expect(turn.state).toBe('answered')
    expect(turn.body).toBe('The web search failed; try again shortly.')
    expect(turn.calls.find((c) => c.tool === 'web_search_exa')).toMatchObject({
      state: 'failed',
      found: null,
    })
  })

  it('lets one of two parallel calls through at one credit under the cap', async () => {
    const exa = await anExa({ config: { dailyCreditCap: 2 } })
    await db.insert(enrichmentRecord).values({
      entityId: null,
      provider: 'exa',
      raw: {},
      creditsUsed: 1,
      integrationId: exa,
    })
    const { fetch, seen } = fakeMcp(tag())
    const runId = await run(
      openRunProgram({
        task: 'Ask',
        entityId: null,
        startedBy: { type: 'user', id: FIXTURE_ACTOR.id },
      }),
    )
    const sources = await run(mountablesProgram())
    const mounted = await run(mountProgram(sources, { runId, fetch }))
    const server = mounted.servers.at(0)
    if (server === undefined) throw new Error('not mounted')
    const outcomes = await run(
      Effect.all(
        [1, 2].map((i) =>
          Effect.result(
            server.call('web_search_exa', { query: `q${String(i)}` }),
          ),
        ),
        { concurrency: 'unbounded' },
      ),
    )
    expect(outcomes.map((o) => o._tag).sort()).toEqual(['Failure', 'Success'])
    const refused = outcomes.find((o) => o._tag === 'Failure')
    expect(refused?._tag === 'Failure' && refused.failure).toMatchObject({
      _tag: 'PluginCallRefused',
      message: 'daily credit cap (2) reached',
    })
    expect(seen.filter((s) => s.method === 'tools/call')).toHaveLength(1)
    const spent = await db
      .select({ credits: enrichmentRecord.creditsUsed })
      .from(enrichmentRecord)
      .where(eq(enrichmentRecord.integrationId, exa))
    expect(spent.reduce((sum, r) => sum + (r.credits ?? 0), 0)).toBe(2)
    expect(
      (
        await db
          .select({ n: count() })
          .from(aiUsage)
          .where(eq(aiUsage.callerId, exa))
      ).at(0)?.n,
    ).toBe(1)
  })
})

describe('a find row’s verbs', () => {
  async function found() {
    const exa = await anExa()
    const t = tag()
    const fixture = await propertyOps(t)
    const { fetch } = fakeMcp(t)
    const { model } = scriptedModel(findSteps(t))
    const events = await collect(
      askEvents({
        userId: FIXTURE_ACTOR.id,
        threadId: null,
        question: 'Rental software startups in India',
        scope: [chip(fixture.ops, 'Property ops'), WEB],
        model,
        pluginFetch: fetch,
      }),
    )
    const first = events.at(0)
    if (first?.type !== 'turn') throw new Error('no turn')
    return {
      ...fixture,
      exa,
      turnId: endOf(events).id,
      threadId: first.threadId,
    }
  }

  const deals = async () =>
    (
      await db
        .select({ n: count() })
        .from(entity)
        .where(eq(entity.kind, 'deal'))
    ).at(0)?.n

  const filedIn = async (entityId: string, spaceId: string) =>
    (
      await db
        .select({ n: count() })
        .from(entitySpace)
        .where(
          and(
            eq(entitySpace.entityId, entityId),
            eq(entitySpace.spaceId, spaceId),
          ),
        )
    ).at(0)?.n === 1

  it('Add resolves the company and files nothing; no deal is made', async () => {
    const { ops, turnId, d } = await found()
    const before = await deals()
    const added = await run(addFindRowProgram(FIXTURE_ACTOR.id, turnId, d.nova))
    expect(added.created).toBe(true)
    expect(added.filed).toBe(false)
    expect(await filedIn(added.entityId, ops)).toBe(false)
    expect(await deals()).toBe(before)
  })

  it('Add and file here accepts the space’s open card — a watch’s included — so the domain is one card', async () => {
    const { ops, turnId, d, exa } = await found()
    const watch = (
      await db
        .insert(spaceWatch)
        .values({ spaceId: ops, integrationId: exa, settings: {} })
        .returning({ id: spaceWatch.id })
    ).at(0)
    if (!watch) throw new Error('no watch')
    await discoverWith({
      claim: {
        spaceId: ops,
        name: 'Nova Rentals',
        domain: d.nova,
        evidence: [{ url: `https://${d.nova}/` }],
      },
      proposedBy: { type: 'integration', id: exa },
      watchId: watch.id,
    })
    const before = await deals()
    const added = await run(
      fileFindRowProgram(FIXTURE_ACTOR.id, turnId, d.nova),
    )
    expect(added).toMatchObject({ created: true, filed: true })
    expect(await filedIn(added.entityId, ops)).toBe(true)
    const cards = await db
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(sql`${suggestion.payload} ->> 'domain' = ${d.nova}`)
    expect(cards).toEqual([{ status: 'accepted' }])
    expect(await deals()).toBe(before)

    // Read again, the row is filed here.
    const thread = await run(
      getThreadProgram(
        FIXTURE_ACTOR.id,
        (
          await db
            .select({ threadId: askTurn.threadId })
            .from(askTurn)
            .where(eq(askTurn.id, turnId))
        ).at(0)?.threadId ?? '',
      ),
    )
    const table = tableOf(thread.turns.at(-1)?.calls ?? [])
    expect(table.rows.find((r) => r.domain === d.nova)?.standing).toBe('filed')
  })

  it('File here files a company held elsewhere', async () => {
    const { ops, keyhold, turnId, d } = await found()
    const filed = await run(
      fileFindRowProgram(FIXTURE_ACTOR.id, turnId, d.keyhold),
    )
    expect(filed).toEqual({ entityId: keyhold, created: false, filed: true })
    expect(await filedIn(keyhold, ops)).toBe(true)
  })

  it('Dismiss is permanent for the space: hidden on a later read, and a watch never proposes it', async () => {
    const { ops, turnId, threadId, d, exa } = await found()
    await run(dismissFindRowProgram(FIXTURE_ACTOR.id, turnId, d.nova))
    const rows = await db
      .select()
      .from(spaceWatchDismissal)
      .where(eq(spaceWatchDismissal.spaceId, ops))
    expect(rows.map((r) => r.domain).sort()).toEqual([d.gone, d.nova].sort())
    const thread = await run(getThreadProgram(FIXTURE_ACTOR.id, threadId))
    const table = tableOf(thread.turns.at(-1)?.calls ?? [])
    expect(table.rows.map((r) => r.domain)).not.toContain(d.nova)
    expect(table.hidden).toBe(2)
    // The history reader takes the table as stored, reading nothing again.
    const stored = await run(
      turnViewsProgram(
        FIXTURE_ACTOR.id,
        await run(threadTurnsProgram(threadId)),
        'stored',
      ),
    )
    expect(
      tableOf(stored.at(-1)?.calls ?? []).rows.map((r) => r.domain),
    ).toContain(d.nova)
    expect(
      await discoverWith({
        claim: {
          spaceId: ops,
          name: 'Nova Rentals',
          domain: d.nova,
          evidence: [],
        },
        proposedBy: { type: 'integration', id: exa },
        watchId: null,
      }),
    ).toEqual({ outcome: 'dismissed' })
  })

  it('refuses a row of somebody else’s thread', async () => {
    const { turnId, d } = await found()
    await expect(
      run(addFindRowProgram('nobody', turnId, d.nova)),
    ).rejects.toMatchObject({ _tag: 'FindRefused' })
  })
})
