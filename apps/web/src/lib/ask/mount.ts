import { Clock, Effect, Schema } from 'effect'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import type { JSONSchema7 } from 'ai'
import { z } from 'zod'
import { db } from '@spaces/db'
import { aiUsage, enrichmentRecord, integration } from '@spaces/db/schema'
import type { IntegrationConfig } from '@spaces/db/schema'
import { Http, manifestSchema } from '@spaces/sdk'
import type { JobError, JsonValue, Manifest } from '@spaces/sdk'
import { utcDayStart } from '@spaces/core/ai/caps'
import { jsonValue } from '@spaces/core/json'
import {
  capRefusal,
  creditDefaults,
  creditPolicy,
} from '@spaces/core/plugins/credit'
import { makeScrub } from '@spaces/core/writes/ports/binding'
import type { Scrub } from '@spaces/core/writes/ports/binding'
import { HttpLive } from '@spaces/core/writes/ports/http'
import type { FetchLike } from '@spaces/core/writes/ports/http'
import { resolveSecretById } from '@spaces/core/writes/vault'
import { runnable } from '#/lib/integrations/runnable'
import { askQuery } from './query'
import type { AskVia } from './types'

/**
 * A plugin's MCP server, mounted for one Ask turn. (D72, D77)
 * - Mounted only from a runnable row whose stored manifest declares `mcp`:
 *   a disabled, degraded or breaker-tripped integration offers no tools.
 * - The key comes from the vault by the row's credential and goes in the
 *   manifest's header; it is never handed to the browser or the model.
 * - Every request goes through `HttpLive`, the plugin's own throttle; each
 *   tool call is charged first — the daily credit cap checked and a receipt
 *   (spend is only receipts, D53) and an `ai_usage` row written, as the
 *   integration's, under the turn's run — and refused when it cannot be.
 * - The caller decides whether to mount at all: a sensitive scope never
 *   reaches this module.
 */

/** What one tool call spends against the integration's daily cap. */
export const MCP_CALL_CREDITS = 1

/** How long a server's tool list is reused before it is asked again. */
const TOOL_LIST_TTL_MS = 10 * 60 * 1000

/** The most text of one tool answer the model is handed. */
const ANSWER_MAX_CHARS = 20_000

const PROTOCOL_VERSION = '2025-06-18'

/** A tool call refused before anything was sent: the cap, as it stands. */
export class PluginCallRefused extends Schema.TaggedError<PluginCallRefused>()(
  'PluginCallRefused',
  { message: Schema.String },
) {}

/** A server that did not answer, or answered with an error. */
export class PluginCallFailed extends Schema.TaggedError<PluginCallFailed>()(
  'PluginCallFailed',
  { message: Schema.String },
) {}

/** An integration whose MCP server a turn may mount. */
export type WebSource = AskVia & { pluginId: string }

type Mountable = WebSource & {
  manifest: Manifest
  mcp: NonNullable<Manifest['mcp']>
  config: IntegrationConfig
  credentialId: string | null
}

/** Runnable rows whose stored manifest declares an MCP server, by plugin id. */
export const mountablesProgram = Effect.fn('ask.mountables')(function* () {
  const rows = yield* askQuery(() =>
    db
      .select({
        id: integration.id,
        manifest: integration.manifest,
        config: integration.config,
        credentialId: integration.credentialId,
      })
      .from(integration)
      .where(runnable)
      .orderBy(asc(integration.capabilityId), asc(integration.createdAt)),
  )
  return rows.flatMap((row): Array<Mountable> => {
    const parsed = manifestSchema.safeParse(row.manifest)
    if (!parsed.success || parsed.data.mcp === undefined) return []
    return [
      {
        integrationId: row.id,
        pluginId: parsed.data.id,
        name: parsed.data.name,
        manifest: parsed.data,
        mcp: parsed.data.mcp,
        config: row.config,
        credentialId: row.credentialId,
      },
    ]
  })
})

/** What the dock's web chip and the space head's Find companies read. */
export const webSourcesProgram = Effect.fn('ask.webSources')(function* () {
  const rows = yield* mountablesProgram()
  return rows.map((r): WebSource => ({
    integrationId: r.integrationId,
    pluginId: r.pluginId,
    name: r.name,
  }))
})

// ---------- the wire: JSON-RPC over streamable HTTP ----------

const toolInputSchema = z.custom<JSONSchema7>(
  (v) => z.looseObject({ type: z.literal('object') }).safeParse(v).success,
  { error: 'a tool input schema is a JSON Schema object' },
)

const toolList = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string().min(1),
      description: z.string().optional(),
      inputSchema: toolInputSchema,
    }),
  ),
})

const toolResult = z.looseObject({
  content: z.array(
    z.looseObject({ type: z.string(), text: z.string().optional() }),
  ),
  isError: z.boolean().optional(),
})

const rpcMessage = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
})

/** The JSON-RPC messages a response carries: one JSON body, or SSE events. */
export function rpcMessages(
  contentType: string,
  body: string,
): Array<z.infer<typeof rpcMessage>> {
  const payloads = contentType.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trimStart())
          .join('\n')
        return data === '' ? [] : [data]
      })
    : [body]
  return payloads.flatMap((text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.flatMap((m) => {
      const msg = rpcMessage.safeParse(m)
      return msg.success ? [msg.data] : []
    })
  })
}

/** The URLs a tool answer names, in order, each once. */
export function urlsIn(text: string): Array<string> {
  const found = text.match(/https?:\/\/[^\s"'<>()[\]{}]+/g) ?? []
  return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))]
}

/** One tool a mounted server offers, as the server listed it. */
export type McpTool = {
  name: string
  description: string
  inputSchema: JSONSchema7
}

/** One tool call's answer, as text the model reads. */
export type McpAnswer = {
  text: string
  isError: boolean
  /** The pages the answer names: what a find row may cite. */
  urls: ReadonlyArray<string>
}

/** A server mounted for one turn. */
export type MountedServer = {
  source: WebSource
  tools: ReadonlyArray<McpTool>
  call: (
    tool: string,
    args: { readonly [k: string]: JsonValue },
  ) => Effect.Effect<McpAnswer, PluginCallRefused | PluginCallFailed>
}

const toolLists = new Map<string, { at: number; tools: Array<McpTool> }>()

/** Forget every cached tool list; a test starts clean. */
export const clearToolLists = () => toolLists.clear()

export type MountOptions = {
  /** The turn's run: each call's `ai_usage` row names it. */
  runId: string
  /** The test seam: a fake network under the real throttle. */
  fetch?: FetchLike
}

const failedWith = (scrub: Scrub, name: string) => (e: JobError) =>
  new PluginCallFailed({ message: scrub(`${name}: ${e.reason}`) })

/** One mountable, keyed and wired: its tool list and its call. */
const mountOne = Effect.fn('ask.mountOne')(function* (
  source: Mountable,
  options: MountOptions,
): Effect.fn.Return<MountedServer, PluginCallFailed> {
  const key =
    source.credentialId === null
      ? null
      : yield* Effect.tryPromise({
          try: () => resolveSecretById(source.credentialId ?? ''),
          catch: () =>
            new PluginCallFailed({
              message: `${source.name}: its key could not be read`,
            }),
        })
  if (key === null)
    return yield* new PluginCallFailed({
      message: `${source.name} has no workspace key`,
    })
  const scrub = makeScrub([key])
  const rpm = source.manifest.http?.rateLimit?.rpm
  const http = HttpLive({
    integrationId: source.integrationId,
    pluginId: source.pluginId,
    scrub,
    ...(rpm === undefined ? {} : { rpm }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const fail = (message: string) =>
    new PluginCallFailed({ message: scrub(`${source.name}: ${message}`) })
  let session: string | null = null
  let initialized = false
  let nextId = 1

  const post = (
    body: { [k: string]: JsonValue },
    expectAnswer: boolean,
  ): Effect.Effect<unknown, PluginCallFailed> =>
    Effect.gen(function* () {
      const id = nextId++
      const headers: Record<string, string> = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        [source.mcp.auth.header]:
          source.mcp.auth.scheme === undefined
            ? key
            : `${source.mcp.auth.scheme} ${key}`,
      }
      if (session !== null) headers['mcp-session-id'] = session
      if (initialized) headers['mcp-protocol-version'] = PROTOCOL_VERSION
      const res = yield* (yield* Http)
        .request({
          method: 'POST',
          url: source.mcp.url,
          headers,
          body: expectAnswer
            ? { jsonrpc: '2.0', id, ...body }
            : { jsonrpc: '2.0', ...body },
        })
        .pipe(Effect.mapError(failedWith(scrub, source.name)))
      if (res.status >= 400)
        return yield* fail(
          `answered ${String(res.status)}${res.body.trim() === '' ? '' : ` — ${res.body.trim().slice(0, 200)}`}`,
        )
      const header = (name: string): string | null =>
        Object.hasOwn(res.headers, name) ? res.headers[name] : null
      session = header('mcp-session-id') ?? session
      if (!expectAnswer) return null
      const reply = rpcMessages(header('content-type') ?? '', res.body).find(
        (m) => m.id === id,
      )
      if (reply === undefined) return yield* fail('sent no answer')
      if (reply.error !== undefined) return yield* fail(reply.error.message)
      return reply.result
    }).pipe(Effect.provide(http))

  const initialize = Effect.gen(function* () {
    if (initialized) return
    yield* post(
      {
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'spaces-ask', version: '1' },
        },
      },
      true,
    )
    initialized = true
    yield* post({ method: 'notifications/initialized' }, false)
  })

  const cacheKey = `${source.integrationId}:${source.manifest.version}`
  const now = yield* Clock.currentTimeMillis
  const cached = toolLists.get(cacheKey)
  let tools: Array<McpTool>
  if (cached !== undefined && now - cached.at < TOOL_LIST_TTL_MS)
    tools = cached.tools
  else {
    yield* initialize
    const listed = toolList.safeParse(
      yield* post({ method: 'tools/list', params: {} }, true),
    )
    if (!listed.success) return yield* fail('listed its tools unreadably')
    tools = listed.data.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      inputSchema: t.inputSchema,
    }))
    toolLists.set(cacheKey, { at: now, tools })
  }

  const policy = creditPolicy(source.config, creditDefaults(source.manifest))

  /**
   * Charge one call before it is sent: the day's spend read and the receipt
   * and `ai_usage` row written under one lock per integration, so calls in
   * parallel cannot all pass the cap. A call that fails after this has
   * still spent its credit — the cap is never exceeded. Null: refused.
   */
  const charge = (
    tool: string,
    args: { readonly [k: string]: JsonValue },
    at: Date,
  ) =>
    Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`ask-mcp:${source.integrationId}`}))`,
          )
          const cap = policy.dailyCreditCap
          if (cap !== null) {
            const spent =
              (
                await tx
                  .select({
                    spent:
                      sql`coalesce(sum(${enrichmentRecord.creditsUsed}), 0)`.mapWith(
                        Number,
                      ),
                  })
                  .from(enrichmentRecord)
                  .where(
                    and(
                      eq(enrichmentRecord.integrationId, source.integrationId),
                      gte(enrichmentRecord.fetchedAt, utcDayStart(at)),
                    ),
                  )
              ).at(0)?.spent ?? 0
            if (spent + MCP_CALL_CREDITS > cap) return { refused: cap }
          }
          const receipt = (
            await tx
              .insert(enrichmentRecord)
              .values({
                entityId: null,
                provider: source.pluginId,
                raw: jsonValue.parse({ via: 'ask', tool, arguments: args }),
                creditsUsed: MCP_CALL_CREDITS,
                integrationId: source.integrationId,
              })
              .returning({ id: enrichmentRecord.id })
          ).at(0)
          if (!receipt)
            throw new Error('enrichment_record insert returned no row')
          await tx.insert(aiUsage).values({
            lane: 'research',
            provider: source.pluginId,
            model: tool,
            callerType: 'integration',
            callerId: source.integrationId,
            runId: options.runId,
          })
          return { receiptId: receipt.id }
        }),
      catch: () => fail('the call could not be recorded, so it was not sent'),
    })

  const call: MountedServer['call'] = (tool, args) =>
    Effect.gen(function* () {
      const charged = yield* charge(
        tool,
        args,
        new Date(yield* Clock.currentTimeMillis),
      )
      if ('refused' in charged)
        return yield* new PluginCallRefused({
          message: capRefusal(charged.refused),
        })
      yield* initialize
      const answered = toolResult.safeParse(
        yield* post(
          { method: 'tools/call', params: { name: tool, arguments: args } },
          true,
        ),
      )
      if (!answered.success) return yield* fail(`answered ${tool} unreadably`)
      const text = answered.data.content
        .flatMap((c) => (c.text === undefined ? [] : [c.text]))
        .join('\n\n')
      // The answer joins its receipt; the credit was spent either way.
      yield* Effect.ignore(
        Effect.tryPromise(() =>
          db
            .update(enrichmentRecord)
            .set({
              raw: jsonValue.parse({ via: 'ask', tool, arguments: args, text }),
            })
            .where(eq(enrichmentRecord.id, charged.receiptId)),
        ),
      )
      return {
        text: text.slice(0, ANSWER_MAX_CHARS),
        isError: answered.data.isError === true,
        urls: urlsIn(text),
      }
    })

  return {
    source: {
      integrationId: source.integrationId,
      pluginId: source.pluginId,
      name: source.name,
    },
    tools,
    call,
  }
})

/** The servers a turn mounts, and the ones that could not be, with why. */
export type Mounted = {
  servers: ReadonlyArray<MountedServer>
  failed: ReadonlyArray<{ source: WebSource; reason: string }>
}

/** Mount every mountable server for one turn; one that fails is reported. */
export const mountProgram = Effect.fn('ask.mount')(function* (
  sources: ReadonlyArray<Mountable>,
  options: MountOptions,
): Effect.fn.Return<Mounted> {
  const servers: Array<MountedServer> = []
  const failed: Array<{ source: WebSource; reason: string }> = []
  for (const source of sources) {
    const mounted = yield* Effect.result(mountOne(source, options))
    if (mounted._tag === 'Success') servers.push(mounted.success)
    else
      failed.push({
        source: {
          integrationId: source.integrationId,
          pluginId: source.pluginId,
          name: source.name,
        },
        reason: mounted.failure.message,
      })
  }
  return { servers, failed }
})

/** A mounted tool's name as the model calls it: unique across servers. */
export const toolKey = (pluginId: string, tool: string): string =>
  `${pluginId}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
