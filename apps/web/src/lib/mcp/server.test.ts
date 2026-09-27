import { createHash } from 'node:crypto'
import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { entity, link, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { apiToken } from '@spaces/db/schema/tokens'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '#/lib/entities/resolve'
import { getRecordContextHandler } from '#/lib/context/record-handler'
import {
  createApiTokenProgram,
  listApiTokensProgram,
  revokeApiTokenProgram,
} from '#/lib/tokens/store'
import { handleMcpRequest } from './server'

/**
 * SPA-23 — the MCP read surface, end to end: a real MCP client speaks
 * Streamable HTTP to `handleMcpRequest` (the `/api/mcp` route's whole body)
 * through an in-process fetch, with a token minted by the real store. The
 * one thing a suite cannot build — the browser session `getRecordContext`
 * reads — is stubbed exactly as `ai/providers/settings.test.ts` stubs it,
 * so the record page's own handler runs for the byte-for-byte comparison.
 */

const session: { current: { id: string; role: string } | null } = {
  current: null,
}

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('http://localhost/companies'),
}))

vi.mock('#/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        session.current ? { user: session.current } : null,
    },
  },
}))

const ENDPOINT = 'http://localhost/api/mcp'
const inProcess = (url: string | URL, init?: RequestInit) =>
  handleMcpRequest(new Request(url, init))

/**
 * The SDK's HTTP client transport, relayed through a plain `Transport`: its
 * `sessionId` getter reads `string | undefined`, which the interface's
 * optional `sessionId?: string` refuses under `exactOptionalPropertyTypes`.
 * The relay carries everything else across unchanged.
 */
function relay(inner: StreamableHTTPClientTransport): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion(version),
  }
  inner.onmessage = (message: JSONRPCMessage) => outer.onmessage?.(message)
  inner.onerror = (error) => outer.onerror?.(error)
  inner.onclose = () => outer.onclose?.()
  return outer
}

async function connect(token: string) {
  const client = new Client({ name: 'spa23-test', version: '0.0.0' })
  await client.connect(
    relay(
      new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        fetch: inProcess,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    ),
  )
  return client
}

/** The one text block a tool answers with. */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const block = Array.isArray(result.content) ? result.content.at(0) : null
  if (!block || block.type !== 'text' || typeof block.text !== 'string')
    throw new Error('expected one text block')
  return block.text
}

const mint = (userId: string, name: string) =>
  Effect.runPromise(createApiTokenProgram({ userId, name }))

/** Just enough of `McpRecord` to read the answer without asserting a type. */
const RecordShape = z.object({
  attributes: z.array(
    z.object({ slug: z.string(), name: z.string(), type: z.string() }),
  ),
  links: z.array(
    z.object({
      direction: z.enum(['in', 'out']),
      relation: z.string(),
      entity: z.object({ id: z.string() }),
    }),
  ),
})

const TEAMMATE = {
  id: 'spa23-teammate',
  name: 'Teammate',
  email: 'spa23-teammate@spaces.test',
}

const fixture = {
  companyId: '',
  companyName: 'Orbital Composites',
  sharedNoteId: '',
  privateNoteId: '',
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE)
  const co = await resolveEntity({
    kind: 'company',
    name: fixture.companyName,
    keys: { domain: 'orbital-composites.example' },
    source: { class: 'manual' },
  })
  fixture.companyId = co.entityId

  const mkNote = async (
    title: string,
    authorId: string,
    visibility: 'shared' | 'private',
  ) => {
    const [e] = await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: title })
      .returning({ id: entity.id })
    await db.insert(note).values({
      entityId: e.id,
      title,
      bodyMd: `${title} body`,
      kind: 'note',
      authorId,
      visibility,
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    })
    await db.insert(link).values({
      fromEntityId: e.id,
      toEntityId: co.entityId,
      relation: 'mentions',
      source: 'manual',
    })
    return e.id
  }
  fixture.sharedNoteId = await mkNote(
    'Partner call',
    FIXTURE_ACTOR.id,
    'shared',
  )
  fixture.privateNoteId = await mkNote(
    'Private doubts about Orbital',
    FIXTURE_ACTOR.id,
    'private',
  )
})

afterEach(() => {
  vi.useRealTimers()
  session.current = null
})

describe('the token store', () => {
  it('shows the plaintext once and keeps only its sha256', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'Claude Desktop')
    expect(created.token).toMatch(/^spk_[A-Za-z0-9_-]{43}$/)
    expect(created.token.startsWith(created.prefix)).toBe(true)

    const row = (
      await db.select().from(apiToken).where(eq(apiToken.id, created.id))
    ).at(0)
    expect(row?.tokenHash).toBe(
      createHash('sha256').update(created.token).digest('hex'),
    )
    // No column of the stored row carries the plaintext.
    expect(JSON.stringify(row)).not.toContain(created.token)

    // The ledger never carries it either — not the token, not the hash.
    const listed = await Effect.runPromise(
      listApiTokensProgram(FIXTURE_ACTOR.id),
    )
    const mine = listed.find((t) => t.id === created.id)
    expect(mine).toBeDefined()
    expect(Object.keys(mine ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'revokedAt',
    ])
    expect(JSON.stringify(listed)).not.toContain(created.token)
  })

  it('refuses a nameless token and a revoke of somebody else’s', async () => {
    const nameless = await Effect.runPromiseExit(
      createApiTokenProgram({ userId: FIXTURE_ACTOR.id, name: '   ' }),
    )
    expect(nameless._tag).toBe('Failure')

    const theirs = await mint(TEAMMATE.id, 'theirs')
    const exit = await Effect.runPromiseExit(
      revokeApiTokenProgram({ userId: FIXTURE_ACTOR.id, id: theirs.id }),
    )
    expect(exit._tag).toBe('Failure')
  })
})

describe('the endpoint refuses without a live token', () => {
  const listTools = (headers: Record<string, string>) =>
    handleMcpRequest(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      }),
    )

  it('answers 401 with no tool list to a missing, unknown or revoked token', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'soon revoked')
    await Effect.runPromise(
      revokeApiTokenProgram({ userId: FIXTURE_ACTOR.id, id: created.id }),
    )
    for (const headers of [
      {},
      { authorization: 'Bearer spk_not-a-real-token' },
      { authorization: 'Basic Zm9vOmJhcg==' },
      { authorization: `Bearer ${created.token}` },
    ]) {
      const res = await listTools(headers)
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).not.toContain('get_context')
      expect(body).not.toContain('get_record')
    }
    await expect(connect(created.token)).rejects.toThrow()
  })

  it('answers a live token’s GET and DELETE 405 — stateless, no session', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'verbs')
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcpRequest(
        new Request(ENDPOINT, {
          method,
          headers: { authorization: `Bearer ${created.token}` },
        }),
      )
      expect(res.status).toBe(405)
    }
    // …and a missing token is still a 401 whatever the verb.
    const bare = await handleMcpRequest(new Request(ENDPOINT))
    expect(bare.status).toBe(401)
  })

  it('stamps last_used_at on a live token', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'used')
    const client = await connect(created.token)
    await client.close()
    const row = (
      await db
        .select({ lastUsedAt: apiToken.lastUsedAt })
        .from(apiToken)
        .where(eq(apiToken.id, created.id))
    ).at(0)
    expect(row?.lastUsedAt).toBeInstanceOf(Date)
  })
})

describe('an MCP client with a per-user token', () => {
  it('lists exactly two tools, with their input schemas', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'lister')
    const client = await connect(created.token)
    const { tools } = await client.listTools()
    await client.close()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_context',
      'get_record',
    ])
    const ctx = tools.find((t) => t.name === 'get_context')
    expect(Object.keys(ctx?.inputSchema.properties ?? {}).sort()).toEqual([
      'budget',
      'entity',
      'task',
    ])
    expect(ctx?.inputSchema.required).toEqual(['entity'])
    const rec = tools.find((t) => t.name === 'get_record')
    expect(Object.keys(rec?.inputSchema.properties ?? {})).toEqual(['id'])
    expect(rec?.inputSchema.required).toEqual(['id'])
  })

  it('get_context returns getRecordContext byte for byte, for the same user, budget and asOf', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'context')
    const client = await connect(created.token)
    // One clock for both surfaces: only `Date` is faked, so the transport's
    // timers still run.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'))

    session.current = { id: FIXTURE_ACTOR.id, role: 'member' }
    for (const budget of [undefined, 1200]) {
      const page = await getRecordContextHandler({
        entityId: fixture.companyId,
        ...(budget === undefined ? {} : { budgetChars: budget }),
      })
      const byId = textOf(
        await client.callTool({
          name: 'get_context',
          arguments: {
            entity: fixture.companyId,
            ...(budget === undefined ? {} : { budget }),
          },
        }),
      )
      expect(byId).toBe(JSON.stringify(page))
      expect(page.items.length).toBeGreaterThan(0)
    }

    // By exact name, the same record and the same bytes.
    const page = await getRecordContextHandler({ entityId: fixture.companyId })
    const byName = textOf(
      await client.callTool({
        name: 'get_context',
        arguments: { entity: fixture.companyName.toLowerCase() },
      }),
    )
    expect(byName).toBe(JSON.stringify(page))
    await client.close()
  })

  it('never shows a second user the first user’s private note, through either tool', async () => {
    const author = await connect((await mint(FIXTURE_ACTOR.id, 'author')).token)
    const other = await connect((await mint(TEAMMATE.id, 'teammate')).token)
    const privateRef = `note:${fixture.privateNoteId}`
    const privateTitle = 'Private doubts about Orbital'

    // get_context on the company
    const authorCtx = textOf(
      await author.callTool({
        name: 'get_context',
        arguments: { entity: fixture.companyId },
      }),
    )
    expect(authorCtx).toContain(privateRef)
    const otherCtx = textOf(
      await other.callTool({
        name: 'get_context',
        arguments: { entity: fixture.companyId },
      }),
    )
    expect(otherCtx).toContain(`note:${fixture.sharedNoteId}`)
    expect(otherCtx).not.toContain(privateRef)
    expect(otherCtx).not.toContain(privateTitle)

    // get_record on the company: the link to the private note is not there
    const authorRec = textOf(
      await author.callTool({
        name: 'get_record',
        arguments: { id: fixture.companyId },
      }),
    )
    expect(authorRec).toContain(fixture.privateNoteId)
    const otherRecResult = await other.callTool({
      name: 'get_record',
      arguments: { id: fixture.companyId },
    })
    expect(otherRecResult.isError).not.toBe(true)
    const otherRec = textOf(otherRecResult)
    expect(otherRec).toContain(fixture.sharedNoteId)
    expect(otherRec).not.toContain(fixture.privateNoteId)
    expect(otherRec).not.toContain(privateTitle)

    // asked for directly — by id through both tools, and by name — the
    // private note does not exist for the teammate
    for (const call of [
      { name: 'get_record', arguments: { id: fixture.privateNoteId } },
      { name: 'get_context', arguments: { entity: fixture.privateNoteId } },
    ]) {
      const res = await other.callTool(call)
      expect(res.isError).toBe(true)
      expect(textOf(res)).not.toContain(privateTitle)
    }
    // By name, the refusal is the one any unknown name gets: it echoes only
    // what the teammate typed, and says nothing about whether it exists.
    const byName = await other.callTool({
      name: 'get_context',
      arguments: { entity: privateTitle },
    })
    expect(byName.isError).toBe(true)
    expect(textOf(byName)).toBe(`No record named "${privateTitle}"`)
    // …while its author reads it
    const own = await author.callTool({
      name: 'get_record',
      arguments: { id: fixture.privateNoteId },
    })
    expect(own.isError).not.toBe(true)
    expect(textOf(own)).toContain(privateTitle)

    await author.close()
    await other.close()
  })

  it('get_record is registry-shaped: object, attributes in registry order, links', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'rec')).token)
    const rec: unknown = JSON.parse(
      textOf(
        await client.callTool({
          name: 'get_record',
          arguments: { id: fixture.companyId },
        }),
      ),
    )
    await client.close()
    expect(rec).toMatchObject({
      id: fixture.companyId,
      kind: 'company',
      name: fixture.companyName,
      mergedFrom: null,
      object: { slug: 'companies' },
    })
    const { attributes, links } = z.parse(RecordShape, rec)
    expect(attributes.length).toBeGreaterThan(0)
    expect(attributes.every((a) => a.slug && a.name && a.type)).toBe(true)
    expect(links).toContainEqual(
      expect.objectContaining({
        direction: 'in',
        relation: 'mentions',
        entity: expect.objectContaining({ id: fixture.sharedNoteId }),
      }),
    )
  })
})
