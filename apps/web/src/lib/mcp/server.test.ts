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
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { getRecordContextHandler } from '#/lib/context/record-handler'
import {
  createApiTokenProgram,
  listApiTokensProgram,
  revokeApiTokenProgram,
} from '#/lib/tokens/store'
import { handleMcpRequest } from './server'
import { searchAllHandler } from '#/lib/search/search-all-handler'
import { setMemberBannedHandler } from '#/lib/members/suspend'
import { createObjectProgram } from '@spaces/core/writes/attributes/object-registry'
import { createAttributeProgram } from '@spaces/core/writes/attributes/create'
import { readEmbeddingPinProgram } from '#/lib/ai/embedding-pin'

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
      'scopes',
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
  it('lists exactly its tools, with their input schemas', async () => {
    const created = await mint(FIXTURE_ACTOR.id, 'lister')
    const client = await connect(created.token)
    const { tools } = await client.listTools()
    await client.close()

    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_context',
      'get_record',
      'list_registry', // SPA-28
      'propose_suggestion', // SPA-31
      'search_records', // SPA-28
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

/**
 * SPA-28 — the other two read tools. `search_records` is Cmd-K's search run
 * as the token's user, compared against the palette's own request half
 * (`searchAllHandler`, the `searchAll` server fn's body) under a stubbed
 * session; `list_registry` reads the registry on every call, so an object
 * made after the client connected is in the next answer.
 */
describe('SPA-28: search_records and list_registry', () => {
  const SUSPENDED = {
    id: 'spa28-suspended',
    name: 'Leaving Member',
    email: 'spa28-suspended@spaces.test',
  }
  const COOLING = 'Submersa Immersion Cooling'

  const HitsShape = z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      objectSlug: z.string().nullable(),
      matchedIn: z.string(),
      rowKind: z.enum(['entity', 'task']),
    }),
  )
  const RegistryShape = z.array(
    z.object({
      slug: z.string(),
      singular: z.string(),
      isSystem: z.boolean(),
      attributes: z.array(
        z.object({
          slug: z.string(),
          name: z.string(),
          type: z.string(),
          target: z.string().nullable(),
          options: z.object({
            options: z.array(z.object({ label: z.string() })).optional(),
          }),
        }),
      ),
    }),
  )

  const call = async (
    client: Client,
    name: string,
    args: Record<string, string>,
  ): Promise<unknown> =>
    JSON.parse(textOf(await client.callTool({ name, arguments: args })))

  beforeAll(async () => {
    await db.insert(user).values(SUSPENDED)
    await resolveEntity({
      kind: 'company',
      name: COOLING,
      keys: { domain: 'submersa.example' },
      source: { class: 'manual' },
    })
  })

  it('lists both tools beside the SPA-23 two, with their input schemas', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'l28')).token)
    const { tools } = await client.listTools()
    await client.close()
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'get_context',
        'get_record',
        'search_records',
        'list_registry',
      ]),
    )
    const search = tools.find((t) => t.name === 'search_records')
    expect(Object.keys(search?.inputSchema.properties ?? {}).sort()).toEqual([
      'object',
      'query',
    ])
    expect(search?.inputSchema.required).toEqual(['query'])
    const registry = tools.find((t) => t.name === 'list_registry')
    expect(Object.keys(registry?.inputSchema.properties ?? {})).toEqual([
      'object',
    ])
    expect(registry?.inputSchema.required ?? []).toEqual([])
  })

  it('search_records answers exactly what Cmd-K answers the same user, lexical lanes with no embedding pin', async () => {
    // No pin: the semantic lane cannot join, and the tool is still there.
    expect(await Effect.runPromise(readEmbeddingPinProgram())).toBeNull()

    for (const who of [FIXTURE_ACTOR.id, TEAMMATE.id]) {
      const client = await connect((await mint(who, `search ${who}`)).token)
      session.current = { id: who, role: 'member' }
      for (const q of ['immersion cooling', 'orbital', 'Private doubts']) {
        const res = await client.callTool({
          name: 'search_records',
          arguments: { query: q },
        })
        expect(res.isError).not.toBe(true)
        // The palette's settled answer is its second wave; with no pin both
        // waves are the same lexical statement.
        const palette = await searchAllHandler({ q, semantic: true })
        expect(textOf(res)).toBe(JSON.stringify(palette))
        expect(palette).toEqual(await searchAllHandler({ q }))
      }
      await client.close()
    }

    // …and the hits are real: the company by a word of its name.
    const client = await connect((await mint(FIXTURE_ACTOR.id, 's')).token)
    const hits = z.parse(
      HitsShape,
      await call(client, 'search_records', { query: 'immersion cooling' }),
    )
    await client.close()
    expect(hits.at(0)).toMatchObject({
      name: COOLING,
      kind: 'company',
      objectSlug: 'companies',
      matchedIn: 'name',
    })
    expect(hits.every((h) => h.matchedIn !== 'semantic')).toBe(true)
  })

  it('search_records applies canRead as the token’s user: a teammate’s private note never comes back', async () => {
    const search = async (userId: string) => {
      const client = await connect((await mint(userId, 'canread')).token)
      const text = textOf(
        await client.callTool({
          name: 'search_records',
          arguments: { query: 'Private doubts about Orbital' },
        }),
      )
      await client.close()
      return text
    }
    expect(await search(FIXTURE_ACTOR.id)).toContain(fixture.privateNoteId)
    const theirs = await search(TEAMMATE.id)
    expect(theirs).not.toContain(fixture.privateNoteId)
    expect(theirs).not.toContain('Private doubts')
  })

  it('search_records narrows to one object by slug or name, and refuses an unknown one', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'o')).token)
    const all = z.parse(
      HitsShape,
      await call(client, 'search_records', { query: 'orbital' }),
    )
    // Unnarrowed, the company and its notes both come back…
    expect(all.some((h) => h.kind === 'note')).toBe(true)
    for (const object of ['companies', 'Company', 'COMPANIES']) {
      const narrowed = z.parse(
        HitsShape,
        await call(client, 'search_records', { query: 'orbital', object }),
      )
      // …narrowed, only the company's object remains.
      expect(narrowed.map((h) => h.id)).toEqual([fixture.companyId])
    }
    const unknown = await client.callTool({
      name: 'search_records',
      arguments: { query: 'orbital', object: 'Spaceships' },
    })
    await client.close()
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toContain('No object "Spaceships"')
    expect(textOf(unknown)).toContain('companies')
  })

  it('list_registry shows a custom object created after the client connected, with no restart', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'reg')).token)
    const before = z.parse(
      RegistryShape,
      await call(client, 'list_registry', {}),
    )
    expect(before.map((o) => o.slug).slice(0, 3)).toEqual([
      'companies',
      'people',
      'deals',
    ])
    const companies = before.find((o) => o.slug === 'companies')
    expect(companies?.attributes.length).toBeGreaterThan(0)
    expect(before.some((o) => o.singular === 'Fund')).toBe(false)

    // The same connected client; the object is made after it connected.
    const fund = await Effect.runPromise(
      createObjectProgram({
        singular: 'Fund',
        plural: 'Funds',
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    const actor = { createdBy: FIXTURE_ACTOR.id, objectId: fund.id }
    await Effect.runPromise(
      createAttributeProgram({ ...actor, name: 'Vintage', type: 'number' }),
    )
    await Effect.runPromise(
      createAttributeProgram({
        ...actor,
        name: 'Strategy',
        type: 'select',
        options: [{ label: 'Venture' }, { label: 'Growth' }],
      }),
    )
    await Effect.runPromise(
      createAttributeProgram({
        ...actor,
        name: 'Anchor LP',
        type: 'record_reference',
        config: { targetKind: 'company' },
      }),
    )

    for (const object of ['Fund', 'funds']) {
      const after = z.parse(
        RegistryShape,
        await call(client, 'list_registry', { object }),
      )
      expect(after).toHaveLength(1)
      expect(after.at(0)).toMatchObject({
        slug: 'funds',
        singular: 'Fund',
        isSystem: false,
      })
      const attrs = after.at(0)?.attributes ?? []
      expect(attrs.map((a) => [a.name, a.type])).toEqual([
        ['Vintage', 'number'],
        ['Strategy', 'select'],
        ['Anchor LP', 'record_reference'],
      ])
      expect(
        attrs
          .find((a) => a.name === 'Strategy')
          ?.options.options?.map((o) => o.label),
      ).toEqual(['Venture', 'Growth'])
      expect(attrs.find((a) => a.name === 'Anchor LP')?.target).toBe(
        'companies',
      )
    }
    const everything = z.parse(
      RegistryShape,
      await call(client, 'list_registry', {}),
    )
    expect(everything.map((o) => o.slug)).toContain('funds')
    await client.close()
  })

  it('answers 401 on both tools once the token’s user is suspended from the workspace, and again once restored', async () => {
    const created = await mint(SUSPENDED.id, 'leaving')
    const client = await connect(created.token)
    const calls = [
      { name: 'search_records', arguments: { query: 'orbital' } },
      { name: 'list_registry', arguments: {} },
    ]
    for (const c of calls)
      expect((await client.callTool(c)).isError).not.toBe(true)

    // Settings → Members → Suspend access, through its real body.
    session.current = { id: FIXTURE_ACTOR.id, role: 'admin' }
    await setMemberBannedHandler({ userId: SUSPENDED.id, banned: true })

    // The connected client is refused on its very next call — every request
    // is authenticated afresh — and a bare request sees no tool at all.
    for (const c of calls) await expect(client.callTool(c)).rejects.toThrow()
    await client.close()
    for (const c of calls) {
      const res = await handleMcpRequest(
        new Request(ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${created.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: c,
          }),
        }),
      )
      expect(res.status).toBe(401)
      expect(await res.text()).toBe('{"error":"unauthorized"}')
    }
    await expect(connect(created.token)).rejects.toThrow()

    // Restoring access restores the same token; nothing was revoked.
    await setMemberBannedHandler({ userId: SUSPENDED.id, banned: false })
    const back = await connect(created.token)
    for (const c of calls)
      expect((await back.callTool(c)).isError).not.toBe(true)
    await back.close()
  })
})
