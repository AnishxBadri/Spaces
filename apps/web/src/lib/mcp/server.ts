import { Cause, Effect, Exit, Option, Result } from 'effect'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { authenticateBearerProgram } from '#/lib/tokens/store'
import type { TokenUser } from '#/lib/tokens/store'
import { toolRegistry } from './registry'
import type { ToolCaller } from './registry'

/**
 * The MCP server: the tool table in
 * `toolRegistry` as a surface a person's own assistant connects to. Ask is
 * the other client of the same table.
 *
 * - Transport: the SDK's web-standard Streamable HTTP transport, stateless —
 *   a fresh server and transport per request, JSON responses, no session.
 * - A per-user bearer token from the token store; no token, a bad one or a
 *   revoked one is a 401 before the MCP layer sees the request, so an
 *   unauthenticated client never learns the tool list.
 * - Every tool runs as the token's user: canRead is theirs.
 * - `tools/list` and `tools/call` are answered on the SDK's underlying
 *   server, from the registry's own JSON Schema and decode, so the SDK never
 *   reads a tool's schema; the answers are the ones its `registerTool` gave.
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

/** A refusal in the words and code the SDK's own tool handler used. */
const invalidParams = (message: string) =>
  text(new McpError(ErrorCode.InvalidParams, message).message, true)

export function buildMcpServer(reader: TokenUser): McpServer {
  const mcp = new McpServer(SERVER_INFO)
  const caller: ToolCaller = {
    userId: reader.id,
    proposer: { kind: 'token', tokenId: reader.tokenId },
  }
  mcp.server.registerCapabilities({ tools: { listChanged: true } })
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolRegistry.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execution: { taskSupport: 'forbidden' as const },
    })),
  }))
  // Called through the registry at request time, never captured here, so
  // the external client and Ask share one door.
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const tool = toolRegistry.tools.find((t) => t.name === name)
    if (tool === undefined) return invalidParams(`Tool ${name} not found`)
    const input = tool.decode(request.params.arguments)
    if (Result.isFailure(input))
      return invalidParams(
        `Input validation error: Invalid arguments for tool ${name}: ${input.failure}`,
      )
    return answer(
      toolRegistry
        .call(name, caller, input.success)
        .pipe(Effect.map((a) => a.value)),
    )
  })
  return mcp
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
  // The same store the /api/v1 door authenticates against, but scopes are
  // not consulted: they gate the HttpApi procedures, not the MCP tools. A
  // token with no scopes ('{}') works over MCP; every tool runs as the
  // token's user, so this widens nothing canRead does not already allow.
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
