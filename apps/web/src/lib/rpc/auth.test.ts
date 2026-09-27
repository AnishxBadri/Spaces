import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { FetchHttpClient } from 'effect/unstable/http'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { entity, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { apiToken } from '@spaces/db/schema/tokens'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { getRecordProgram } from '#/lib/mcp/tools'
import {
  createApiTokenProgram,
  hashApiToken,
  listApiTokensProgram,
  revokeApiTokenProgram,
} from '#/lib/tokens/store'
import type { ApiClient } from './api'
import {
  Forbidden,
  SCOPE_PROBE_PATH,
  UNAUTHORIZED_MESSAGE,
  Unauthorized,
  failureBody,
  handleApiRequest,
  handleScopeProbeRequest,
  makeApiClient,
} from './api'

/**
 * SPA-48 — the personal-token store opens the HttpApi door. The same
 * `api_token` rows the MCP server reads are the bearer here; the middleware
 * in `api.ts` refuses 401 for anything but a live token and 403 for a live
 * token without the procedure's scope, and puts the token's user in the
 * procedure's context. Everything goes through `handleApiRequest`, the
 * function the `/api/v1/$` route hands a request to — what curl sends.
 */

const ORIGIN = 'http://spaces.test'
const ME = `${ORIGIN}/api/v1/me`
const PROBE = `${ORIGIN}${SCOPE_PROBE_PATH}`

const TEAMMATE = {
  id: 'spa48-teammate',
  name: 'Teammate',
  email: 'spa48-teammate@spaces.test',
}
const SUSPENDED = {
  id: 'spa48-suspended',
  name: 'Suspended',
  email: 'spa48-suspended@spaces.test',
  banned: true,
}

const mint = (userId: string, scopes: ReadonlyArray<string>) =>
  Effect.runPromise(createApiTokenProgram({ userId, name: 'spa48', scopes }))

const bearer = (token: string): RequestInit => ({
  headers: { authorization: `Bearer ${token}` },
})

const call = (url: string, init?: RequestInit) =>
  (url.startsWith(PROBE) ? handleScopeProbeRequest : handleApiRequest)(
    new Request(url, init),
  )

/** The typed client over the mounted handler, carrying `token`. */
const withClient = <TValue, TError>(
  token: string | undefined,
  use: (client: ApiClient) => Effect.Effect<TValue, TError>,
  fetch: typeof globalThis.fetch = (input, init) =>
    handleApiRequest(new Request(input, init)),
) =>
  Effect.runPromise(
    Effect.flatMap(makeApiClient(ORIGIN, token), use).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  )

const fixture = { privateNoteId: '' }

beforeAll(async () => {
  await db.insert(user).values([TEAMMATE, SUSPENDED])
  const [e] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: 'Private doubts' })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: e.id,
    title: 'Private doubts',
    bodyMd: 'Private doubts body',
    kind: 'note',
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  })
  fixture.privateNoteId = e.id
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session.me', () => {
  it('answers the token’s user and granted scopes over REST', async () => {
    const created = await mint(FIXTURE_ACTOR.id, ['records:read'])
    const response = await call(ME, bearer(created.token))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      user: {
        id: FIXTURE_ACTOR.id,
        name: FIXTURE_ACTOR.name,
        email: FIXTURE_ACTOR.email,
      },
      scopes: ['records:read'],
    })
  })

  it('answers the same bytes through the typed client', async () => {
    const created = await mint(TEAMMATE.id, [
      'suggestions:write',
      'capture:write',
    ])
    const overHttp = await (await call(ME, bearer(created.token))).text()
    const viaClient = await withClient(created.token, (client) =>
      client.session.me(),
    )
    expect(JSON.stringify(viaClient)).toBe(overHttp)
    // The pinned order, whatever order they were asked for in.
    expect(viaClient.scopes).toEqual(['capture:write', 'suggestions:write'])
    expect(viaClient.user.id).toBe(TEAMMATE.id)
  })

  it('answers a token minted with no scopes — any live token opens it', async () => {
    const created = await mint(TEAMMATE.id, [])
    const response = await call(ME, bearer(created.token))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ scopes: [] })
  })

  it('never answers the token or its hash', async () => {
    const created = await mint(TEAMMATE.id, ['records:read'])
    const body = await (await call(ME, bearer(created.token))).text()
    expect(body).not.toContain(created.token)
    expect(body).not.toContain(hashApiToken(created.token))
    expect(body).not.toContain(created.id)
  })
})

describe('401 — one answer for every way a token can fail', () => {
  it('missing, malformed, unknown, revoked and banned read identically', async () => {
    const revoked = await mint(TEAMMATE.id, ['capture:write'])
    await Effect.runPromise(
      revokeApiTokenProgram({ userId: TEAMMATE.id, id: revoked.id }),
    )
    const banned = await mint(SUSPENDED.id, ['capture:write'])
    const unknown = `spk_${'A'.repeat(43)}`

    const cases: Array<[string, RequestInit | undefined]> = [
      ['no header', undefined],
      ['not a bearer', { headers: { authorization: 'Basic Zm9vOmJhcg==' } }],
      ['empty bearer', { headers: { authorization: 'Bearer ' } }],
      ['wrong prefix', bearer('ghp_nottoken')],
      ['unknown', bearer(unknown)],
      ['revoked', bearer(revoked.token)],
      ['banned user', bearer(banned.token)],
    ]
    const expected = JSON.stringify(
      failureBody('Unauthorized', UNAUTHORIZED_MESSAGE),
    )
    for (const [label, init] of cases) {
      for (const url of [ME, PROBE]) {
        const response = await call(url, init)
        expect(response.status, `${label} at ${url}`).toBe(401)
        expect(await response.text(), `${label} at ${url}`).toBe(expected)
      }
    }
  })

  it('the typed client decodes the 401 back into Unauthorized', async () => {
    const error = await withClient(`spk_${'B'.repeat(43)}`, (client) =>
      Effect.flip(client.session.me()),
    )
    expect(error).toBeInstanceOf(Unauthorized)
    expect(error).toMatchObject({ message: UNAUTHORIZED_MESSAGE })
  })

  it('a revoked token that worked a moment ago is refused from then on', async () => {
    const created = await mint(FIXTURE_ACTOR.id, [])
    expect((await call(ME, bearer(created.token))).status).toBe(200)
    await Effect.runPromise(
      revokeApiTokenProgram({ userId: FIXTURE_ACTOR.id, id: created.id }),
    )
    expect((await call(ME, bearer(created.token))).status).toBe(401)
  })
})

describe('403 — a live token without the procedure’s scope', () => {
  it('records:read is refused by a capture:write procedure', async () => {
    const created = await mint(FIXTURE_ACTOR.id, ['records:read'])
    const response = await call(PROBE, bearer(created.token))
    expect(response.status).toBe(403)
    const body: unknown = await response.json()
    expect(body).toEqual(
      failureBody(
        'Forbidden',
        'This token does not hold the capture:write scope',
      ),
    )
    expect(JSON.stringify(body)).not.toContain(created.token)
  })

  it('capture:write is let through, as the token’s user', async () => {
    const created = await mint(TEAMMATE.id, ['capture:write'])
    const response = await call(PROBE, bearer(created.token))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      user: { id: TEAMMATE.id },
      scopes: ['capture:write'],
    })
  })

  it('the typed client decodes a 403 back into Forbidden', async () => {
    const error = await withClient(
      undefined,
      (client) => Effect.flip(client.session.me()),
      () =>
        Promise.resolve(
          Response.json(failureBody('Forbidden', 'no'), { status: 403 }),
        ),
    )
    expect(error).toBeInstanceOf(Forbidden)
  })
})

describe('last_used_at', () => {
  it('advances on use and is what the settings ledger lists', async () => {
    const created = await mint(TEAMMATE.id, ['records:read'])
    const before = await Effect.runPromise(listApiTokensProgram(TEAMMATE.id))
    expect(before.find((t) => t.id === created.id)?.lastUsedAt).toBeNull()

    await call(ME, bearer(created.token))
    const first = (
      await Effect.runPromise(listApiTokensProgram(TEAMMATE.id))
    ).find((t) => t.id === created.id)
    expect(first?.lastUsedAt).not.toBeNull()
    expect(first?.scopes).toEqual(['records:read'])

    // A refusal for scope is still a use of a live token: it advances too.
    await db
      .update(apiToken)
      .set({ lastUsedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(apiToken.id, created.id))
    await call(PROBE, bearer(created.token))
    const second = (
      await Effect.runPromise(listApiTokensProgram(TEAMMATE.id))
    ).find((t) => t.id === created.id)
    expect(second?.lastUsedAt).not.toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('a token is an identity, never an escalation', () => {
  it('canRead runs as the token’s user: another user’s private note stays invisible', async () => {
    // The door hands the procedure the token's user — TEAMMATE, not whoever
    // else exists — and a canRead read path fed that principal cannot see
    // FIXTURE_ACTOR's private note. The MCP suite proves the same over its
    // own transport (`lib/mcp/server.test.ts`), against this same store.
    const theirs = await mint(TEAMMATE.id, [
      'capture:write',
      'records:read',
      'suggestions:write',
    ])
    const principal = await withClient(theirs.token, (client) =>
      client.session.me(),
    )
    expect(principal.user.id).toBe(TEAMMATE.id)
    const refused = await Effect.runPromise(
      Effect.flip(getRecordProgram(principal.user, fixture.privateNoteId)),
    )
    expect(refused).toMatchObject({ _tag: 'McpToolRefused' })

    const own = await mint(FIXTURE_ACTOR.id, [])
    const author = await withClient(own.token, (client) => client.session.me())
    expect(author.user.id).toBe(FIXTURE_ACTOR.id)
    const record = await Effect.runPromise(
      getRecordProgram(author.user, fixture.privateNoteId),
    )
    expect(record.id).toBe(fixture.privateNoteId)
  })
})

describe('the raw token', () => {
  it('is never logged, whatever the answer', async () => {
    const lines: Array<string> = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(
        (...args: Array<unknown>) => {
          lines.push(args.map((a) => String(a)).join(' '))
        },
      )
    }
    const live = await mint(TEAMMATE.id, ['records:read'])
    const revoked = await mint(TEAMMATE.id, [])
    await Effect.runPromise(
      revokeApiTokenProgram({ userId: TEAMMATE.id, id: revoked.id }),
    )
    await call(ME, bearer(live.token))
    await call(PROBE, bearer(live.token))
    await call(ME, bearer(revoked.token))
    for (const line of lines) {
      expect(line).not.toContain(live.token)
      expect(line).not.toContain(revoked.token)
    }
  })

  it('is never stored — the row has its sha256, a display prefix and nothing else', async () => {
    const created = await mint(TEAMMATE.id, ['capture:write'])
    const row = (
      await db.select().from(apiToken).where(eq(apiToken.id, created.id))
    ).at(0)
    expect(row?.tokenHash).toBe(hashApiToken(created.token))
    expect(Object.values(row ?? {}).map(String)).not.toContain(created.token)
    expect(created.token.startsWith(row?.prefix ?? '∅')).toBe(true)
    expect(row?.prefix.length).toBeLessThan(created.token.length)
  })

  it('is never returned after creation — the ledger has no field for it', async () => {
    const created = await mint(TEAMMATE.id, ['capture:write'])
    const rows = await Effect.runPromise(listApiTokensProgram(TEAMMATE.id))
    const listed = JSON.stringify(rows)
    expect(listed).not.toContain(created.token)
    expect(listed).not.toContain(hashApiToken(created.token))
  })
})
