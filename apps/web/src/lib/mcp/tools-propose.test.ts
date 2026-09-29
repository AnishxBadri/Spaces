import { Cause, Effect, Exit, Option } from 'effect'
import { and, eq } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest'
import { db } from '@spaces/db'
import { attributeEvent, entity, note, suggestion } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import {
  acceptProgram,
  proposeProgram,
  SuggestionInvalid,
} from '#/lib/ai/propose'
import type { Decider } from '#/lib/ai/propose'
import type { Actor } from '@spaces/core/writes/attributes/values'
import { listInboxProgram } from '#/lib/inbox/queue'
import { createApiTokenProgram } from '#/lib/tokens/store'
import { handleMcpRequest } from './server'

/**
 * SPA-31 — `propose_suggestion`, the MCP surface's one write verb, end to
 * end: a real MCP client over Streamable HTTP into `handleMcpRequest`, with
 * a token minted by the real store, landing in the real inbox queue. The
 * transport plumbing is the same as `server.test.ts` (SPA-23).
 */

const ENDPOINT = 'http://localhost/api/mcp'
const inProcess = (url: string | URL, init?: RequestInit) =>
  handleMcpRequest(new Request(url, init))

/** See `server.test.ts`: the SDK transport, relayed past its `sessionId`. */
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
  const client = new Client({ name: 'spa31-test', version: '0.0.0' })
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

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const block = Array.isArray(result.content) ? result.content.at(0) : null
  if (!block || block.type !== 'text' || typeof block.text !== 'string')
    throw new Error('expected one text block')
  return block.text
}

const mint = (userId: string, name: string) =>
  Effect.runPromise(createApiTokenProgram({ userId, name }))

const TEAMMATE = {
  id: 'spa31-teammate',
  name: 'Teammate',
  email: 'spa31-teammate@spaces.test',
}

const fixture = { companyId: '', privateNoteId: '' }
const PRIVATE_TITLE = 'Private thoughts on Halcyon'

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE)
  const co = await resolveEntity({
    kind: 'company',
    name: 'Halcyon Robotics',
    keys: { domain: 'halcyon-robotics.example' },
    source: { class: 'manual' },
  })
  fixture.companyId = co.entityId
  const e = (
    await db
      .insert(entity)
      .values({ kind: 'note', canonicalName: PRIVATE_TITLE })
      .returning({ id: entity.id })
  ).at(0)
  if (!e) throw new Error('note entity insert returned no row')
  await db.insert(note).values({
    entityId: e.id,
    title: PRIVATE_TITLE,
    bodyMd: 'mine alone',
    kind: 'note',
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
  })
  fixture.privateNoteId = e.id
})

const suggestionsOn = (entityId: string) =>
  db.select().from(suggestion).where(eq(suggestion.entityId, entityId))

const valuesOf = async (entityId: string) =>
  (
    await db
      .select({ values: entity.values })
      .from(entity)
      .where(eq(entity.id, entityId))
  ).at(0)?.values ?? {}

describe('propose_suggestion — the same one door, from outside', () => {
  it('lands in /inbox labelled with its token, and writes nothing until a person accepts', async () => {
    const token = await mint(FIXTURE_ACTOR.id, 'Claude Desktop')
    const client = await connect(token.token)
    const result = await client.callTool({
      name: 'propose_suggestion',
      arguments: {
        entity: fixture.companyId,
        patch: {
          founded_year: { value: 2019, refs: ['web:about'], confidence: 0.9 },
          location: { value: 'Oslo', refs: [], confidence: 0.7 },
        },
        rationale: 'Their about page says founded 2019 in Oslo',
      },
    })
    await client.close()
    expect(result.isError).not.toBe(true)
    const answer: unknown = JSON.parse(textOf(result))
    expect(answer).toMatchObject({
      entityId: fixture.companyId,
      status: 'open',
      fields: ['founded_year', 'location'],
    })

    // The row: the token as the integration actor, open, refs derived.
    const [row] = await suggestionsOn(fixture.companyId)
    expect(row).toMatchObject({
      kind: 'attribute_patch',
      status: 'open',
      proposedByType: 'integration',
      proposedById: token.id,
      rationale: 'Their about page says founded 2019 in Oslo',
      refs: ['web:about'],
    })

    // Nothing in the database changed but the queue.
    const before = await valuesOf(fixture.companyId)
    expect(before.founded_year).toBeUndefined()
    expect(before.location).toBeUndefined()
    expect(
      await db
        .select()
        .from(attributeEvent)
        .where(
          and(
            eq(attributeEvent.entityId, fixture.companyId),
            eq(attributeEvent.attrSlug, 'founded_year'),
          ),
        ),
    ).toEqual([])

    // An in-app suggestion on the same record, for the contrast.
    const inApp = await Effect.runPromise(
      proposeProgram({
        entityId: fixture.companyId,
        kind: 'attribute_patch',
        payload: { description: { value: 'Robots', refs: [], confidence: 1 } },
        proposedBy: { type: 'user', id: FIXTURE_ACTOR.id },
      }),
    )

    const rows = await Effect.runPromise(
      listInboxProgram({ record: fixture.companyId }),
    )
    const card = rows.find((r) => r.kind === 'suggestion')
    if (card?.kind !== 'suggestion') throw new Error('expected a card')
    const origins = new Map(card.suggestions.map((s) => [s.id, s.origin]))
    expect(origins.get(row.id)).toEqual({
      via: 'mcp',
      token: 'Claude Desktop',
    })
    expect(origins.get(inApp.id)).toEqual({ via: 'app' })

    // A person accepts: now, and only now, the value is written — by them.
    await Effect.runPromise(
      acceptProgram(row.id, { type: 'user', id: FIXTURE_ACTOR.id }),
    )
    const after = await valuesOf(fixture.companyId)
    expect(after.founded_year).toBe(2019)
    const events = await db
      .select()
      .from(attributeEvent)
      .where(
        and(
          eq(attributeEvent.entityId, fixture.companyId),
          eq(attributeEvent.attrSlug, 'founded_year'),
        ),
      )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actorType: 'user',
      actorId: FIXTURE_ACTOR.id,
      source: 'suggestion',
      suggestionId: row.id,
    })
  })

  it('refuses a malformed patch with the validator’s field-level slug: detail', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'bad')).token)
    const before = (await suggestionsOn(fixture.companyId)).length
    const wrongType = await client.callTool({
      name: 'propose_suggestion',
      arguments: {
        entity: fixture.companyId,
        patch: {
          founded_year: { value: 'nineteen', refs: [], confidence: 0.5 },
        },
        rationale: 'guess',
      },
    })
    expect(wrongType.isError).toBe(true)
    expect(textOf(wrongType)).toMatch(/^Proposal refused — founded_year: \S/)

    const bareValue = await client.callTool({
      name: 'propose_suggestion',
      arguments: {
        entity: fixture.companyId,
        patch: { location: 'Oslo' },
        rationale: 'guess',
      },
    })
    expect(bareValue.isError).toBe(true)
    expect(textOf(bareValue)).toContain(
      'location: expected {value, refs, confidence}',
    )
    await client.close()
    // Refused, not dropped: and nothing reached the queue.
    expect(await suggestionsOn(fixture.companyId)).toHaveLength(before)
  })

  it('refuses an attribute the object does not have, naming the slug', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'slug')).token)
    const before = (await suggestionsOn(fixture.companyId)).length
    const res = await client.callTool({
      name: 'propose_suggestion',
      arguments: {
        entity: fixture.companyId,
        // `job_title` is a person's attribute, not a company's.
        patch: { job_title: { value: 'CEO', refs: [], confidence: 1 } },
        rationale: 'wrong object',
      },
    })
    await client.close()
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('job_title: Unknown attribute')
    expect(await suggestionsOn(fixture.companyId)).toHaveLength(before)
  })

  it('applies canRead to the record proposed against — a private note is not proposable', async () => {
    const other = await connect((await mint(TEAMMATE.id, 'teammate')).token)
    const patch = { description: { value: 'x', refs: [], confidence: 1 } }
    const byId = await other.callTool({
      name: 'propose_suggestion',
      arguments: { entity: fixture.privateNoteId, patch, rationale: 'r' },
    })
    expect(byId.isError).toBe(true)
    expect(textOf(byId)).toBe(`No record ${fixture.privateNoteId}`)
    const byName = await other.callTool({
      name: 'propose_suggestion',
      arguments: { entity: PRIVATE_TITLE, patch, rationale: 'r' },
    })
    expect(byName.isError).toBe(true)
    expect(textOf(byName)).toBe(`No record named "${PRIVATE_TITLE}"`)
    await other.close()

    // Its author gets past canRead — and is refused by the registry
    // instead, which is what shows the teammate's refusal was canRead's.
    const author = await connect((await mint(FIXTURE_ACTOR.id, 'own')).token)
    const own = await author.callTool({
      name: 'propose_suggestion',
      arguments: { entity: fixture.privateNoteId, patch, rationale: 'r' },
    })
    await author.close()
    expect(own.isError).toBe(true)
    expect(textOf(own)).not.toContain('No record')
    expect(await suggestionsOn(fixture.privateNoteId)).toEqual([])
  })
})

describe('an agent is a client of the four contracts — no fifth contract, no privileged write path (spec §6)', () => {
  it('offers no accept, write, delete or merge tool; propose is the one non-read tool', async () => {
    const client = await connect((await mint(FIXTURE_ACTOR.id, 'rule')).token)
    const { tools } = await client.listTools()
    await client.close()
    for (const t of tools)
      expect(t.name).not.toMatch(
        /accept|approve|decide|reject|write|set|update|edit|patch|create|insert|delete|remove|archive|merge|tag|link|send/i,
      )
    const writers = tools.filter((t) => t.annotations?.readOnlyHint !== true)
    expect(writers.map((t) => t.name)).toEqual(['propose_suggestion'])
    expect(writers[0]?.annotations?.destructiveHint).toBe(false)
  })

  it('refuses accept() from an integration actor — by type, and at runtime', async () => {
    expectTypeOf<Decider['type']>().toEqualTypeOf<'user'>()
    const token = await mint(FIXTURE_ACTOR.id, 'intruder')
    const client = await connect(token.token)
    const proposed = await client.callTool({
      name: 'propose_suggestion',
      arguments: {
        entity: fixture.companyId,
        patch: { location: { value: 'Mars', refs: [], confidence: 1 } },
        rationale: 'injected by a deck',
      },
    })
    await client.close()
    const { suggestionId } = suggestionIdOf(textOf(proposed))

    const intruder: Actor = { type: 'integration', id: token.id }
    const exit = await Effect.runPromiseExit(
      acceptProgram(
        suggestionId,
        // @ts-expect-error — `Decider` admits only a person; this is the runtime half
        intruder,
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const failure = Exit.isFailure(exit)
      ? Cause.findErrorOption(exit.cause)
      : Option.none()
    expect(Option.isSome(failure)).toBe(true)
    if (Option.isSome(failure)) {
      expect(failure.value).toBeInstanceOf(SuggestionInvalid)
      expect(failure.value.message).toBe(
        'decided_by: only a person accepts a suggestion',
      )
    }
    // Nothing moved: the row is open, the value unwritten.
    const row = (
      await db.select().from(suggestion).where(eq(suggestion.id, suggestionId))
    ).at(0)
    expect(row?.status).toBe('open')
    expect((await valuesOf(fixture.companyId)).location).not.toBe('Mars')
  })
})

/** The proposal's id, read off the tool's answer. */
function suggestionIdOf(body: string): { suggestionId: string } {
  const parsed: unknown = JSON.parse(body)
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('suggestionId' in parsed) ||
    typeof parsed.suggestionId !== 'string'
  )
    throw new Error(`no suggestionId in ${body}`)
  return { suggestionId: parsed.suggestionId }
}
