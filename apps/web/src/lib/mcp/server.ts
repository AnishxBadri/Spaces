import { Cause, Effect, Exit, Option } from 'effect'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  DEFAULT_BUDGET_CHARS,
  recordContextProgram,
} from '#/lib/context/record'
import { authenticateBearerProgram } from '#/lib/tokens/store'
import type { TokenUser } from '#/lib/tokens/store'
import { getRecordProgram, resolveEntityRefProgram } from './tools'
import { jsonValue } from '#/lib/json'
import { proposeSuggestionProgram } from './tools-propose'
import { listRegistryProgram, searchRecordsProgram } from './tools-read'

/**
 * The MCP server (SPA-23, `docs/spec-ai-substrate.md` §5): the four
 * contracts as a tool surface a person's own assistant connects to. This
 * half ships two read tools — `get_context`, the assembler verbatim, and
 * `get_record`, registry-shaped; ai-23b adds `search_records`,
 * `list_registry` and `propose_suggestion`.
 *
 * Transport: the SDK's web-standard Streamable HTTP transport, stateless —
 * a fresh server and transport per request, JSON responses rather than an
 * SSE stream, because the tools answer in one shot and nothing here holds a
 * session. Authentication is a per-user bearer token from the token store
 * (`lib/tokens/store.ts`, the owner's decision recorded there); no token, a
 * bad one or a revoked one is a 401 before the MCP layer sees the request,
 * so an unauthenticated client never learns the tool list.
 *
 * Every tool runs as the token's user. canRead is theirs: a teammate's
 * assistant sees exactly what that teammate sees, and no more.
 */

const SERVER_INFO = { name: 'spaces', version: '0.1.0' }

const text = (body: string, isError = false): CallToolResult =>
  isError
    ? { content: [{ type: 'text', text: body }], isError: true }
    : { content: [{ type: 'text', text: body }] }

/**
 * Run a tool's program to a result. A typed refusal is the assistant's to
 * read (`isError` with the message); a defect is logged and answered
 * generically, so a stack never leaves the box.
 */
async function answer<TValue, TError extends { message: string }>(
  program: Effect.Effect<TValue, TError>,
): Promise<CallToolResult> {
  const exit = await Effect.runPromiseExit(program)
  if (Exit.isSuccess(exit)) return text(JSON.stringify(exit.value))
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure) && failure.value.message)
    return text(failure.value.message, true)
  console.error('[mcp] tool failed', Cause.pretty(exit.cause))
  return text('The tool failed on the server', true)
}

export function buildMcpServer(reader: TokenUser): McpServer {
  const server = new McpServer(SERVER_INFO)
  const me = { id: reader.id }

  server.registerTool(
    'get_context',
    {
      title: 'Record context',
      description:
        'What Spaces knows about one record — its attributes, history, notes, memos, documents, spaces and tasks — ranked and trimmed to a character budget, each item with a citation. Exactly what the record page’s Context section shows the same person. Pass a record id, or a record’s exact name.',
      inputSchema: {
        entity: z
          .string()
          .min(1)
          .describe('Record id (uuid), or the record’s exact name'),
        task: z
          .string()
          .optional()
          .describe(
            'What you are trying to do; ranks matching document passages first',
          ),
        budget: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .optional()
          .describe(`Character budget; default ${DEFAULT_BUDGET_CHARS}`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ entity, task, budget }) =>
      answer(
        Effect.gen(function* () {
          const entityId = yield* resolveEntityRefProgram(me, entity)
          return yield* recordContextProgram({
            entityId,
            user: me,
            asOf: new Date().toISOString(),
            budgetChars: budget ?? DEFAULT_BUDGET_CHARS,
            similar: false,
            taskText: task?.trim() ? task.trim() : undefined,
          })
        }),
      ),
  )

  server.registerTool(
    'get_record',
    {
      title: 'Record',
      description:
        'One record, shaped by its object’s attribute registry: every attribute with its stored value and a readable rendering, then its links in both directions and the spaces it is tagged into.',
      inputSchema: {
        id: z.string().uuid().describe('Record id (uuid)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => answer(getRecordProgram(me, id)),
  )

  // SPA-31: the one write verb — a proposal into the review queue, through
  // the same `proposeProgram` every in-app feature calls. No accept, write,
  // delete or merge tool is registered, ever (spec §6).
  server.registerTool(
    'propose_suggestion',
    {
      title: 'Propose a suggestion',
      description:
        'Propose attribute values for one record. Nothing is written: the proposal lands in the Spaces review inbox, labelled with this token, and a person accepts or rejects it. The patch is keyed by attribute slug (see get_record), each field wrapped as {value, refs, confidence}; it is validated against the record’s live attribute registry and refused field by field.',
      inputSchema: {
        entity: z
          .string()
          .min(1)
          .describe('Record id (uuid), or the record’s exact name'),
        patch: z
          .record(z.string(), jsonValue)
          .describe(
            '{[attribute slug]: {value, refs: string[], confidence: 0..1}}',
          ),
        rationale: z
          .string()
          .min(1)
          .describe('Why these values — what the reviewer reads first'),
        refs: z
          .array(z.string())
          .optional()
          .describe(
            'Citation refs for the whole proposal; default: the union of each field’s refs',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ entity, patch, rationale, refs }) =>
      answer(
        proposeSuggestionProgram(
          { id: reader.id, tokenId: reader.tokenId },
          {
            entity,
            patch,
            rationale,
            ...(refs === undefined ? {} : { refs }),
          },
        ),
      ),
  )

  // ---- SPA-28: search_records and list_registry (`./tools-read.ts`) ----
  server.registerTool(
    'search_records',
    {
      title: 'Search records',
      description:
        'Search Spaces the way its Cmd-K box does — record names and aliases (typo-tolerant), note bodies, document text, tasks, and meaning when an embedding model is configured — fused into one ranked list of at most 20 hits. Each hit carries its id (pass it to get_record or get_context), kind, name, object, and a snippet marked «like this». Pass `object` to keep only one object’s records.',
      inputSchema: {
        query: z.string().min(1).max(200).describe('What to look for'),
        object: z
          .string()
          .min(1)
          .optional()
          .describe(
            'An object’s slug, singular or plural name (see list_registry); only its records are returned',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, object }) =>
      answer(searchRecordsProgram(me, { query, object })),
  )

  server.registerTool(
    'list_registry',
    {
      title: 'Object registry',
      description:
        'The workspace’s object registry: every object (Companies, People, Deals and any custom object), each with its attributes in order — slug, name, description, type, the object a reference points at, and per-type options such as select and status choices. Always current: an object or attribute created a moment ago is listed.',
      inputSchema: {
        object: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Just this object — its slug, singular or plural name; omit for all',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ object }) => answer(listRegistryProgram({ object })),
  )

  return server
}

const unauthorized = () =>
  Response.json(
    { error: 'unauthorized' },
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="spaces"' },
    },
  )

/**
 * One HTTP request to `/api/mcp`. The token is checked first; only a live
 * one reaches the transport.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  // The same store the /api/v1 door authenticates against (SPA-48), but
  // scopes are not consulted here: they gate the HttpApi procedures, and the
  // MCP tools (SPA-28/31) are not on that door. A token minted before scopes
  // existed ('{}') keeps working over MCP exactly as it did; every tool still
  // runs as the token's user, so the missing check widens nothing canRead
  // does not already allow.
  const auth = await Effect.runPromiseExit(
    authenticateBearerProgram(request.headers.get('authorization')),
  )
  if (Exit.isFailure(auth)) {
    const failure = Cause.findErrorOption(auth.cause)
    if (Option.isSome(failure) && failure.value._tag === 'ApiTokenUnauthorized')
      return unauthorized()
    // The store could not answer: not the caller's fault, and not a pass.
    console.error('[mcp] token check failed', Cause.pretty(auth.cause))
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  // Stateless: no session to DELETE and no standalone stream to GET — the
  // spec's answer for a server that offers neither is 405.
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const server = buildMcpServer(auth.value)
  // No `sessionIdGenerator`: its absence is what makes the transport
  // stateless, one per request.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
