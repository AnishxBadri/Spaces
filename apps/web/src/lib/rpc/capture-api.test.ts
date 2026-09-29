import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Effect } from 'effect'
import { and, eq } from 'drizzle-orm'
import { FetchHttpClient } from 'effect/unstable/http'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import { company, document, entity, link, note } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { QUEUES } from '@spaces/core/queue/names'
import { MAX_CAPTURE_BYTES, formatBytes } from '@spaces/core/documents'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { listDocumentsProgram } from '#/lib/documents/shelf'
import { describeExternalOrigin } from '#/lib/server/external-origin'
import { storage } from '@spaces/core/writes/storage'
import { createApiTokenProgram } from '#/lib/tokens/store'
import type { ApiClient } from './api'
import {
  OPENAPI_PATH,
  UnsupportedCaptureSchemaVersion,
  failureBody,
  handleApiRequest,
  makeApiClient,
} from './api'
import { CAPTURE_MIME, captureSchemaRefusal } from './capture'
import {
  ACCEPTED_CAPTURE_SCHEMA_VERSIONS,
  API_PREFIX,
  CAPTURE_SCHEMA_VERSION,
} from './versions'

/**
 * SPA-111 — `POST /api/v1/capture`: page text in, a filed document out,
 * authenticated by a `capture:write` token. Everything goes through
 * `handleApiRequest`, what the `/api/v1/$` route hands a request to — what
 * curl or a bookmarklet sends. The queue is the stub every document fixture
 * uses: birth enqueues extraction, and `enqueued` is the record of it. The
 * row reaching `done` through the unchanged extract job is
 * `worker/jobs/extract-document.capture.test.ts`, on the worker's side of
 * the seam.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

const ORIGIN = 'http://spaces.test'
const CAPTURE = `${ORIGIN}${API_PREFIX}/capture`
const APP = describeExternalOrigin(process.env.APP_URL).origin

const OUTSIDER = {
  id: 'spa111-outsider',
  name: 'Outsider',
  email: 'spa111-outsider@spaces.test',
}

const fixture = {
  captureToken: '',
  readToken: '',
  companyId: '',
  spaceId: '',
  privateNoteId: '',
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

type Payload = {
  captureSchemaVersion: number
  url: string
  title: string
  capturedAt: string
  text: string
  target?: string
}

const page = (overrides: Partial<Payload> = {}): Payload => ({
  captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
  url: 'https://www.linkedin.com/in/ada-example/',
  title: 'Ada Example — Founder at Orbital Composites',
  capturedAt: '2026-09-28T09:30:00Z',
  text: `Ada Example\nFounder at Orbital Composites\n${randomUUID()}`,
  ...overrides,
})

const post = (body: unknown, token = fixture.captureToken) =>
  handleApiRequest(
    new Request(CAPTURE, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )

const Captured = z.object({ documentId: z.string(), url: z.string() })
const Failure = z.object({
  error: z.object({ tag: z.string(), message: z.string() }),
})

const documentsWithSha = (sha: string) =>
  db
    .select({ id: document.entityId })
    .from(document)
    .where(eq(document.blobSha, sha))

const withClient = <TValue, TError>(
  use: (client: ApiClient) => Effect.Effect<TValue, TError>,
) =>
  Effect.runPromise(
    Effect.flatMap(makeApiClient(ORIGIN, fixture.captureToken), use).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
        handleApiRequest(new Request(input, init)),
      ),
    ),
  )

beforeAll(async () => {
  await db.insert(user).values(OUTSIDER)
  const mint = (scopes: Array<string>) =>
    Effect.runPromise(
      createApiTokenProgram({
        userId: FIXTURE_ACTOR.id,
        name: 'spa111',
        scopes,
      }),
    )
  fixture.captureToken = (await mint(['capture:write'])).token
  fixture.readToken = (await mint(['records:read'])).token

  const [c] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: 'Orbital Composites' })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: c.id })
  fixture.companyId = c.id

  const [s] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: 'Spa111 space' })
    .returning({ id: entity.id })
  fixture.spaceId = s.id

  const [n] = await db
    .insert(entity)
    .values({ kind: 'note', canonicalName: 'Outsider private note' })
    .returning({ id: entity.id })
  await db.insert(note).values({
    entityId: n.id,
    title: 'Outsider private note',
    bodyMd: 'not yours',
    kind: 'note',
    authorId: OUTSIDER.id,
    visibility: 'private',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  })
  fixture.privateNoteId = n.id
})

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

describe('POST /api/v1/capture — unfiled', () => {
  it('writes one document through intake: blob, sha, url, name, manual, the token’s user', async () => {
    const body = page()
    const response = await post(body)
    expect(response.status).toBe(200)
    const answer = Captured.parse(await response.json())
    expect(answer.url).toBe(`${APP}/documents?filed=unfiled`)

    const sha = sha256(body.text)
    expect(await documentsWithSha(sha)).toEqual([{ id: answer.documentId }])

    const row = (
      await db
        .select({
          blobSha: document.blobSha,
          url: document.url,
          filename: document.filename,
          mime: document.mime,
          sizeBytes: document.sizeBytes,
          kind: document.kind,
          sourceClass: document.sourceClass,
          sourceRef: document.sourceRef,
          uploadedBy: document.uploadedBy,
          extractionStatus: document.extractionStatus,
          canonicalName: entity.canonicalName,
          createdBy: entity.createdBy,
        })
        .from(document)
        .innerJoin(entity, eq(entity.id, document.entityId))
        .where(eq(document.entityId, answer.documentId))
    ).at(0)
    expect(row).toEqual({
      blobSha: sha,
      url: body.url,
      filename: body.title,
      mime: CAPTURE_MIME,
      sizeBytes: Buffer.byteLength(body.text, 'utf8'),
      kind: 'article',
      // The clip's class (SPA-137): a person, in a first-party surface.
      sourceClass: 'manual',
      sourceRef: null,
      uploadedBy: FIXTURE_ACTOR.id,
      extractionStatus: 'pending',
      canonicalName: body.title,
      createdBy: FIXTURE_ACTOR.id,
    })

    // A real blob — the posted text, byte for byte.
    const stored = await storage().getBytes(sha)
    expect(Buffer.from(stored).toString('utf8')).toBe(body.text)

    // No edge at all: the unfiled inbox is exactly that state.
    expect(
      await db
        .select({ id: link.id })
        .from(link)
        .where(eq(link.fromEntityId, answer.documentId)),
    ).toEqual([])
    const inbox = await Effect.runPromise(
      listDocumentsProgram({ filed: 'unfiled' }),
    )
    expect(inbox.find((d) => d.id === answer.documentId)).toMatchObject({
      url: body.url,
      blobSha: sha,
    })

    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      {
        name: QUEUES.extractDocument,
        data: { documentId: answer.documentId },
      },
    ])
  })

  it('answers the same through the typed client', async () => {
    const body = page()
    const answer = await withClient((client) =>
      client.capture.capture({ payload: body }),
    )
    expect(answer.url).toBe(`${APP}/documents?filed=unfiled`)
    expect(await documentsWithSha(sha256(body.text))).toEqual([
      { id: answer.documentId },
    ])
  })
})

describe('POST /api/v1/capture — filed on a record', () => {
  it('files tagged_in on the record by id, with the source URL on the row', async () => {
    const body = page({ target: fixture.companyId })
    const response = await post(body)
    expect(response.status).toBe(200)
    const answer = Captured.parse(await response.json())
    expect(answer.url).toBe(`${APP}/companies/${fixture.companyId}`)

    // What the Files tab reads: the tagged_in edge onto the record, joined
    // to the document row carrying its url.
    const onTab = await db
      .select({ id: document.entityId, url: document.url })
      .from(link)
      .innerJoin(document, eq(document.entityId, link.fromEntityId))
      .where(
        and(
          eq(link.toEntityId, fixture.companyId),
          eq(link.relation, 'tagged_in'),
          eq(link.fromEntityId, answer.documentId),
        ),
      )
    expect(onTab).toEqual([{ id: answer.documentId, url: body.url }])
  })

  it('re-posting the same page is birth’s sha+target dedupe, not a second row', async () => {
    const body = page({ target: fixture.companyId })
    const first = Captured.parse(await (await post(body)).json())
    const again = Captured.parse(
      await (
        await post({ ...body, capturedAt: '2026-09-29T10:00:00Z' })
      ).json(),
    )
    expect(again.documentId).toBe(first.documentId)
    expect(await documentsWithSha(sha256(body.text))).toEqual([
      { id: first.documentId },
    ])
    const edges = await db
      .select({ id: link.id })
      .from(link)
      .where(eq(link.fromEntityId, first.documentId))
    expect(edges).toHaveLength(1)
    // Extraction was queued for the one row, once.
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([
      { name: QUEUES.extractDocument, data: { documentId: first.documentId } },
    ])
  })

  it('resolves an exact name, case-insensitively, as SPA-23/31 do', async () => {
    const response = await post(page({ target: 'orbital composites' }))
    expect(response.status).toBe(200)
    const answer = Captured.parse(await response.json())
    const edge = await db
      .select({ to: link.toEntityId })
      .from(link)
      .where(eq(link.fromEntityId, answer.documentId))
    expect(edge).toEqual([{ to: fixture.companyId }])
  })

  it('an unknown target is 404 and stores nothing', async () => {
    const body = page({ target: 'No Such Company Anywhere' })
    const response = await post(body)
    expect(response.status).toBe(404)
    expect(Failure.parse(await response.json()).error.tag).toBe('NotFound')
    expect(await documentsWithSha(sha256(body.text))).toEqual([])
    expect(await storage().exists(sha256(body.text))).toBe(false)
  })

  it('a private note the token’s user may not read is not found, by id', async () => {
    const body = page({ target: fixture.privateNoteId })
    const response = await post(body)
    expect(response.status).toBe(404)
    expect(await documentsWithSha(sha256(body.text))).toEqual([])
  })

  it('a target that will not take a document is 400 with birth’s reason', async () => {
    const response = await post(page({ target: fixture.spaceId }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(
      failureBody(
        'BadRequest',
        'A space is filed into, not against — file the document into it.',
      ),
    )
  })
})

describe('captureSchemaVersion', () => {
  it('accepts every version on the accepted list', async () => {
    for (const version of ACCEPTED_CAPTURE_SCHEMA_VERSIONS) {
      const response = await post(page({ captureSchemaVersion: version }))
      expect(response.status, `v${version}`).toBe(200)
    }
    expect(ACCEPTED_CAPTURE_SCHEMA_VERSIONS).toContain(CAPTURE_SCHEMA_VERSION)
  })

  it('refuses an unknown one with “update the extension” and the accepted list', async () => {
    const body = page({ captureSchemaVersion: 999 })
    const response = await post(body)
    expect(response.status).toBe(422)
    const { error } = Failure.parse(await response.json())
    expect(error.tag).toBe('UnsupportedCaptureSchemaVersion')
    expect(error.message).toContain('update the extension')
    expect(error.message).toContain(
      `Accepted versions: ${ACCEPTED_CAPTURE_SCHEMA_VERSIONS.join(', ')}`,
    )
    expect(await documentsWithSha(sha256(body.text))).toEqual([])
  })

  it('a known older version is accepted — the rule, against a list that has one', () => {
    const accepted = [1, 2]
    expect(captureSchemaRefusal(1, accepted)).toBeNull()
    expect(captureSchemaRefusal(2, accepted)).toBeNull()
    expect(captureSchemaRefusal(3, accepted)).toBe(
      'captureSchemaVersion 3 is not one this instance accepts — update the extension. Accepted versions: 1, 2.',
    )
  })

  it('the typed client decodes the 422 back into UnsupportedCaptureSchemaVersion', async () => {
    const error = await withClient((client) =>
      Effect.flip(
        client.capture.capture({
          payload: page({ captureSchemaVersion: 0 }),
        }),
      ),
    )
    expect(error).toBeInstanceOf(UnsupportedCaptureSchemaVersion)
  })
})

describe('the cap', () => {
  it('refuses text over MAX_CAPTURE_BYTES before anything is stored, naming the limit', async () => {
    const text = 'a'.repeat(MAX_CAPTURE_BYTES + 1)
    const response = await post(page({ text, target: fixture.companyId }))
    expect(response.status).toBe(413)
    const { error } = Failure.parse(await response.json())
    expect(error.tag).toBe('PayloadTooLarge')
    expect(error.message).toContain(formatBytes(MAX_CAPTURE_BYTES))
    expect(error.message).toContain(String(MAX_CAPTURE_BYTES))
    expect(await documentsWithSha(sha256(text))).toEqual([])
    expect(await storage().exists(sha256(text))).toBe(false)
    const { enqueued } = await import('#/test/queue-stub')
    expect(enqueued).toEqual([])
  })

  it('counts UTF-8 bytes, not characters', async () => {
    // Under the cap in characters, over it in bytes: é is two bytes.
    const text = 'é'.repeat(MAX_CAPTURE_BYTES / 2 + 1)
    expect(text.length).toBeLessThan(MAX_CAPTURE_BYTES)
    expect((await post(page({ text }))).status).toBe(413)
  })
})

describe('the payload schema', () => {
  it('a missing title, a non-http URL or a bad date is 400', async () => {
    const { title: _dropped, ...untitled } = page()
    for (const body of [
      untitled,
      page({ url: 'javascript:alert(1)' }),
      page({ url: 'not a url' }),
      page({ capturedAt: 'yesterday-ish' }),
      page({ text: '   ' }),
    ]) {
      const response = await post(body)
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(Failure.parse(await response.json()).error.tag).toBe('BadRequest')
    }
  })

  it('requires capture:write — records:read is 403', async () => {
    const response = await post(page(), fixture.readToken)
    expect(response.status).toBe(403)
  })

  it('is in the OpenAPI document as POST, bearer-secured, with a body', async () => {
    const doc: unknown = await (
      await handleApiRequest(new Request(`${ORIGIN}${OPENAPI_PATH}`))
    ).json()
    const Doc = z.object({
      paths: z.object({
        [`${API_PREFIX}/capture`]: z.object({
          post: z.object({
            operationId: z.string(),
            security: z.array(z.record(z.string(), z.unknown())).min(1),
            requestBody: z.object({ required: z.literal(true) }),
          }),
        }),
      }),
    })
    const op = Doc.parse(doc).paths[`${API_PREFIX}/capture`].post
    expect(op.operationId).toBe('capture.capture')
  })
})

describe('the capture module writes nothing of its own', () => {
  it('has no insert and no storage put — intake is the one lane', () => {
    const source = readFileSync(
      new URL('./capture.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/\.insert\(/)
    expect(source).not.toContain('storage()')
    expect(source).toContain('intakeDocumentProgram(')
  })
})
