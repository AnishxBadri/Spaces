import { Effect } from 'effect'
import { eq } from 'drizzle-orm'
import { FetchHttpClient } from 'effect/unstable/http'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  company,
  entity,
  entityAlias,
  link,
  note,
  person,
} from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { createObjectProgram } from '@spaces/core/writes/attributes/object-registry'
import { objectIdForKind } from '@spaces/core/writes/attributes/objects'
import {
  listCompaniesPageProgram,
  listDealsPageProgram,
  listPeoplePageProgram,
} from '#/lib/views/directory'
import { listRecordsProgram } from '#/lib/views/records'
import { createApiTokenProgram } from '#/lib/tokens/store'
import type { ApiClient } from './api'
import {
  BadRequest,
  NotFound,
  OPENAPI_PATH,
  failureBody,
  handleApiRequest,
  makeApiClient,
} from './api'
import { API_PREFIX } from './versions'

/**
 * SPA-80 — the read half of integration map #11: `registry.list`,
 * `records.list(object, cursor?, limit?)` and `records.get(id)`, each
 * `records:read`, each a wrapper over a program the app already runs. Every
 * call goes through `handleApiRequest` (what curl and n8n hit) or the typed
 * client over it (the generated client of this codebase).
 */

const ORIGIN = 'http://spaces.test'
const at = (path: string) => `${ORIGIN}${API_PREFIX}${path}`

const TEAMMATE = {
  id: 'spa80-teammate',
  name: 'Teammate',
  email: 'spa80-teammate@spaces.test',
}

const mint = async (userId: string, scopes: ReadonlyArray<string>) =>
  (
    await Effect.runPromise(
      createApiTokenProgram({ userId, name: 'spa80', scopes }),
    )
  ).token

const get = (path: string, token: string) =>
  handleApiRequest(
    new Request(at(path), { headers: { authorization: `Bearer ${token}` } }),
  )

const withClient = <TValue, TError>(
  token: string,
  use: (client: ApiClient) => Effect.Effect<TValue, TError>,
) =>
  Effect.runPromise(
    Effect.flatMap(makeApiClient(ORIGIN, token), use).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        handleApiRequest(new Request(input, init)),
      ),
    ),
  )

/** Every page of `object` through the typed client, cursor to exhaustion. */
const walkClient = (token: string, object: string, limit: number) =>
  withClient(token, (client) =>
    Effect.gen(function* () {
      const pages: Array<{ ids: Array<string>; nextCursor: string | null }> = []
      let cursor: string | undefined
      for (;;) {
        const page = yield* client.records.list({
          params: { object },
          query: cursor === undefined ? { limit } : { limit, cursor },
        })
        pages.push({
          ids: page.rows.map((r) => r.id),
          nextCursor: page.nextCursor,
        })
        if (page.nextCursor === null) return pages
        cursor = page.nextCursor
      }
    }),
  )

type ProgramPage = {
  rows: Array<{ id: string }>
  nextCursor: string | null
}

/** The same walk through the in-app program, the same page size. */
async function walkProgram(
  run: (options: {
    cursor: string | null
    limit: number
  }) => Effect.Effect<ProgramPage, unknown>,
  limit: number,
) {
  const pages: Array<{ ids: Array<string>; nextCursor: string | null }> = []
  let cursor: string | null = null
  for (;;) {
    const page: ProgramPage = await Effect.runPromise(run({ cursor, limit }))
    pages.push({ ids: page.rows.map((r) => r.id), nextCursor: page.nextCursor })
    if (page.nextCursor === null) return pages
    cursor = page.nextCursor
  }
}

const fixture = {
  readToken: '',
  teammateToken: '',
  companyIds: new Array<string>(),
  orbitalId: '',
  privateNoteId: '',
  customObject: { id: '', slug: '' },
}

const PRIVATE_TITLE = 'Private doubts about Orbital'
const PRIVATE_BODY = 'The burn rate is worse than they say'

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE)
  fixture.readToken = await mint(FIXTURE_ACTOR.id, ['records:read'])
  fixture.teammateToken = await mint(TEAMMATE.id, ['records:read'])
  const objectOf = (kind: 'company' | 'person' | 'deal') =>
    Effect.runPromise(objectIdForKind(kind))

  const companiesObject = await objectOf('company')
  const peopleObject = await objectOf('person')
  const dealsObject = await objectOf('deal')
  // Eleven companies in one statement — one created_at, so the page
  // boundaries fall inside a tie and only `id` orders them.
  const companies = await db
    .insert(entity)
    .values(
      Array.from({ length: 11 }, (_, i) => ({
        kind: 'company' as const,
        objectId: companiesObject,
        canonicalName: `Company ${String(i).padStart(2, '0')}`,
        values: { description: `Maker #${i}`, gone_attr: 'stale' },
      })),
    )
    .returning({ id: entity.id })
  await db.insert(company).values(companies.map((c) => ({ entityId: c.id })))
  await db.insert(entityAlias).values(
    companies.map((c, i) => ({
      entityId: c.id,
      kind: 'domain' as const,
      value: `company-${i}.example`,
      valueNorm: `company-${i}.example`,
      isIdentity: true,
    })),
  )
  fixture.companyIds = companies.map((c) => c.id)
  fixture.orbitalId = companies[0].id

  const people = await db
    .insert(entity)
    .values(
      Array.from({ length: 4 }, (_, i) => ({
        kind: 'person' as const,
        objectId: peopleObject,
        canonicalName: `Person ${i}`,
      })),
    )
    .returning({ id: entity.id })
  await db.insert(person).values(people.map((p) => ({ entityId: p.id })))

  await db.insert(entity).values(
    Array.from({ length: 3 }, (_, i) => ({
      kind: 'deal' as const,
      objectId: dealsObject,
      canonicalName: `Deal ${i}`,
    })),
  )

  const object = await Effect.runPromise(
    createObjectProgram({
      singular: 'Fund',
      plural: 'Funds',
      createdBy: FIXTURE_ACTOR.id,
    }),
  )
  fixture.customObject = object
  // Staggered one by one, so the order is by created_at, not only by id.
  for (let i = 0; i < 7; i++)
    await db.insert(entity).values({
      kind: 'custom',
      objectId: object.id,
      canonicalName: `Fund ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
    })

  // The MCP suite's fixture: a private note by FIXTURE_ACTOR that mentions a
  // company, so it sits at the far end of one of that company's links.
  const [n] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: PRIVATE_TITLE })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: n.id,
    title: PRIVATE_TITLE,
    bodyMd: PRIVATE_BODY,
    kind: 'note',
    authorId: FIXTURE_ACTOR.id,
    visibility: 'private',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  })
  await db.insert(link).values({
    fromEntityId: n.id,
    toEntityId: fixture.orbitalId,
    relation: 'mentions',
    source: 'manual',
  })
  fixture.privateNoteId = n.id
})

// ---------------------------------------------------------------------------

const OPERATIONS = [
  { id: 'registry.list', path: `${API_PREFIX}/registry` },
  { id: 'records.list', path: `${API_PREFIX}/objects/{object}/records` },
  { id: 'records.get', path: `${API_PREFIX}/records/{id}` },
] as const

const Operation = z.object({
  operationId: z.string(),
  tags: z.array(z.string()),
  parameters: z
    .array(z.object({ name: z.string(), in: z.string() }))
    .default([]),
  requestBody: z.unknown().optional(),
  security: z.array(z.record(z.string(), z.array(z.string()))),
  responses: z.record(
    z.string(),
    z.object({
      content: z
        .object({ 'application/json': z.object({ schema: z.unknown() }) })
        .optional(),
    }),
  ),
})

const Document = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
})

const fetchDocument = async () =>
  Document.parse(
    await (
      await handleApiRequest(new Request(`${ORIGIN}${OPENAPI_PATH}`))
    ).json(),
  )

describe('the OpenAPI document', () => {
  it('lists all three procedures, bearer-secured, each with a 200 response schema', async () => {
    const doc = await fetchDocument()
    for (const { id, path } of OPERATIONS) {
      expect(doc.paths, id).toHaveProperty([path, 'get'])
      const op = Operation.parse(doc.paths[path].get)
      expect(op.operationId).toBe(id)
      expect(op.security).toEqual([{ bearer: [] }])
      expect(op.responses, id).toHaveProperty('200')
      expect(
        op.responses['200'].content?.['application/json'].schema,
        `${id} declares its 200 schema`,
      ).toBeDefined()
    }
  })
})

describe('records.list — paging', () => {
  it('a generated client walks a full cursor to exhaustion, every company once', async () => {
    const pages = await walkClient(fixture.readToken, 'companies', 3)
    expect(pages.map((p) => p.ids.length)).toEqual([3, 3, 3, 2])
    const seen = pages.flatMap((p) => p.ids)
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual([...fixture.companyIds].sort())
  })

  it('returns the in-app list’s rows in its order, page for page — companies, people, deals and a custom object', async () => {
    const token = fixture.readToken
    const cases: Array<
      [
        string,
        (o: {
          cursor: string | null
          limit: number
        }) => Effect.Effect<ProgramPage, unknown>,
      ]
    > = [
      ['companies', (o) => listCompaniesPageProgram([], o)],
      ['people', (o) => listPeoplePageProgram([], o)],
      ['deals', (o) => listDealsPageProgram([], o)],
      [
        fixture.customObject.slug,
        (o) => listRecordsProgram(fixture.customObject.id, [], o),
      ],
    ]
    for (const [object, program] of cases) {
      const overApi = await walkClient(token, object, 2)
      const inApp = await walkProgram(program, 2)
      expect(overApi, object).toEqual(inApp)
      expect(overApi.flatMap((p) => p.ids).length, object).toBeGreaterThan(2)
    }
  })

  it('serializes registry-shaped: live attribute slugs as keys, a company’s domains beside them', async () => {
    const response = await get(
      '/objects/companies/records?limit=200',
      fixture.readToken,
    )
    expect(response.status).toBe(200)
    const body = z
      .object({
        object: z.string(),
        total: z.number(),
        rows: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            values: z.record(z.string(), z.unknown()),
            domains: z.array(z.string()),
          }),
        ),
      })
      .parse(await response.json())
    expect(body.object).toBe('companies')
    expect(body.total).toBe(11)
    const first = body.rows.find((r) => r.id === fixture.orbitalId)
    expect(first).toMatchObject({
      name: 'Company 00',
      values: { description: 'Maker #0' },
      domains: ['company-0.example'],
    })
    // Not an attribute in the registry, so not something a caller could read.
    expect(first?.values).not.toHaveProperty('gone_attr')
  })

  it('names the object by its singular or plural too, and refuses an unknown one with 404', async () => {
    const byName = await get('/objects/Fund/records', fixture.readToken)
    expect(byName.status).toBe(200)
    expect(await byName.json()).toMatchObject({
      object: fixture.customObject.slug,
    })

    const unknown = await get('/objects/unicorns/records', fixture.readToken)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ error: { tag: 'NotFound' } })
  })

  it('a cursor it never handed out is a 400, not a silent restart', async () => {
    for (const cursor of ['garbage', btoa('{"k":null,"id":"x"}')]) {
      const response = await get(
        `/objects/companies/records?cursor=${encodeURIComponent(cursor)}`,
        fixture.readToken,
      )
      expect(response.status, cursor).toBe(400)
    }
    const error = await withClient(fixture.readToken, (client) =>
      Effect.flip(
        client.records.list({
          params: { object: 'companies' },
          query: { cursor: 'garbage' },
        }),
      ),
    )
    expect(error).toBeInstanceOf(BadRequest)
  })

  it('a limit outside 1…200 is a 400', async () => {
    for (const limit of ['0', '201', 'ten'])
      expect(
        (
          await get(
            `/objects/companies/records?limit=${limit}`,
            fixture.readToken,
          )
        ).status,
        limit,
      ).toBe(400)
  })

  it('a cursor pointing at a since-deleted record still returns the stable next page', async () => {
    const object = await Effect.runPromise(
      createObjectProgram({
        singular: 'Vehicle',
        plural: 'Vehicles',
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    for (let i = 0; i < 6; i++)
      await db.insert(entity).values({
        kind: 'custom',
        objectId: object.id,
        canonicalName: `Vehicle ${i}`,
        createdAt: new Date(Date.UTC(2026, 1, 1 + i)),
      })
    const all = (await walkClient(fixture.readToken, object.slug, 200)).flatMap(
      (p) => p.ids,
    )
    expect(all).toHaveLength(6)

    const first = await withClient(fixture.readToken, (client) =>
      client.records.list({
        params: { object: object.slug },
        query: { limit: 2 },
      }),
    )
    expect(first.rows.map((r) => r.id)).toEqual(all.slice(0, 2))
    const cursor = first.nextCursor
    expect(cursor).not.toBeNull()

    // The row the cursor names goes away between the two calls.
    await db.delete(entity).where(eq(entity.id, all[1]))

    const next = await withClient(fixture.readToken, (client) =>
      client.records.list({
        params: { object: object.slug },
        query: { limit: 2, cursor: cursor ?? '' },
      }),
    )
    expect(next.rows.map((r) => r.id)).toEqual(all.slice(2, 4))
  })
})

describe('records.get', () => {
  it('answers one record registry-shaped, through the typed client', async () => {
    const record = await withClient(fixture.readToken, (client) =>
      client.records.get({ params: { id: fixture.orbitalId } }),
    )
    expect(record).toMatchObject({
      id: fixture.orbitalId,
      kind: 'company',
      name: 'Company 00',
      object: { slug: 'companies' },
      values: { description: 'Maker #0' },
    })
    expect(record.values).not.toHaveProperty('gone_attr')
  })

  it('a private note is absent for a token whose user cannot read it — the record, its link and its body', async () => {
    // The author sees it, and sees it at the far end of the company's link.
    const own = await get(
      `/records/${fixture.privateNoteId}`,
      fixture.readToken,
    )
    expect(own.status).toBe(200)
    const ownCompany = await (
      await get(`/records/${fixture.orbitalId}`, fixture.readToken)
    ).text()
    expect(ownCompany).toContain(fixture.privateNoteId)

    // The teammate: not found, not refused — and nothing of it anywhere.
    const theirs = await get(
      `/records/${fixture.privateNoteId}`,
      fixture.teammateToken,
    )
    expect(theirs.status).toBe(404)
    const refused = await theirs.text()
    expect(refused).not.toContain(PRIVATE_TITLE)
    expect(refused).not.toContain(PRIVATE_BODY)

    const theirCompany = await get(
      `/records/${fixture.orbitalId}`,
      fixture.teammateToken,
    )
    expect(theirCompany.status).toBe(200)
    const text = await theirCompany.text()
    expect(text).not.toContain(fixture.privateNoteId)
    expect(text).not.toContain(PRIVATE_TITLE)
    expect(text).not.toContain(PRIVATE_BODY)

    const error = await withClient(fixture.teammateToken, (client) =>
      Effect.flip(
        client.records.get({ params: { id: fixture.privateNoteId } }),
      ),
    )
    expect(error).toBeInstanceOf(NotFound)
  })

  it('an unknown id is a 404 in the envelope', async () => {
    const response = await get(
      '/records/00000000-0000-4000-8000-000000000000',
      fixture.readToken,
    )
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual(
      failureBody('NotFound', 'No record 00000000-0000-4000-8000-000000000000'),
    )
  })
})

describe('registry.list', () => {
  const Registry = z.object({
    objects: z.array(
      z.object({
        slug: z.string(),
        attributes: z.array(z.object({ slug: z.string() })),
      }),
    ),
  })

  it('reflects a custom object created minutes earlier, with no restart', async () => {
    const before = Registry.parse(
      await (await get('/registry', fixture.readToken)).json(),
    )
    expect(before.objects.map((o) => o.slug)).toEqual(
      expect.arrayContaining(['companies', 'people', 'deals']),
    )
    expect(before.objects.map((o) => o.slug)).not.toContain('portfolios')

    const created = await Effect.runPromise(
      createObjectProgram({
        singular: 'Portfolio',
        plural: 'Portfolios',
        createdBy: FIXTURE_ACTOR.id,
      }),
    )
    await db.insert(entity).values({
      kind: 'custom',
      objectId: created.id,
      canonicalName: 'Fund I',
    })

    const after = await withClient(fixture.readToken, (client) =>
      client.registry.list(),
    )
    expect(after.objects.map((o) => o.slug)).toContain(created.slug)
    // …and its records are listable the same minute.
    const page = await withClient(fixture.readToken, (client) =>
      client.records.list({ params: { object: created.slug }, query: {} }),
    )
    expect(page.rows.map((r) => r.name)).toEqual(['Fund I'])
  })
})

describe('records:read', () => {
  it('is required by all three — a token without it is 403, no token 401', async () => {
    const other = await mint(FIXTURE_ACTOR.id, ['capture:write'])
    for (const path of [
      '/registry',
      '/objects/companies/records',
      `/records/${fixture.orbitalId}`,
    ]) {
      expect((await get(path, other)).status, path).toBe(403)
      expect((await handleApiRequest(new Request(at(path)))).status, path).toBe(
        401,
      )
    }
  })
})

/**
 * Three things are absent from this surface on purpose, and each has an
 * owner elsewhere. If this test fails, a parameter or verb was added here —
 * delete the test deliberately, in the slice that owns it, not in passing.
 */
describe('no filter, search or write on records/registry — owned by docsurf-12b + ai-18 (filters), clean-5 + ai-11 (search) and ai-24 (writes)', () => {
  it('only GET verbs, no request body, and no parameter beyond object, id, cursor and limit', async () => {
    const doc = await fetchDocument()
    const ours = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item).flatMap(([method, raw]) => {
        const op = Operation.safeParse(raw)
        return op.success &&
          op.data.tags.some((t) => t === 'records' || t === 'registry')
          ? [{ path, method, op: op.data }]
          : []
      }),
    )
    expect(ours.map((o) => o.op.operationId).sort()).toEqual([
      'records.get',
      'records.list',
      'registry.list',
    ])
    for (const { path, method, op } of ours) {
      // ai-24: proposals go through its single door, nothing writes here.
      expect(method, `${path} is read-only`).toBe('get')
      expect(op.requestBody, `${path} takes no body`).toBeUndefined()
      // docsurf-12b + ai-18: one filter dialect, the view evaluator's.
      // clean-5 + ai-11: one search, the fused query (MCP has it, ai-23b).
      for (const p of op.parameters) {
        expect(
          ['object', 'id', 'cursor', 'limit'],
          `${path} ${p.name}`,
        ).toContain(p.name)
        expect(p.name).not.toMatch(
          /filter|condition|where|search|query|^q$|sort|order/i,
        )
      }
    }
  })
})
