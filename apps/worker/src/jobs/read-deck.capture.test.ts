import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect } from 'effect'
import { MockLanguageModelV4 } from 'ai/test'
import { and, count, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { db } from '@spaces/db'
import {
  aiRun,
  document,
  entity,
  link,
  objectDef,
  suggestion,
} from '@spaces/db/schema'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../vitest.seed'
import { enqueued } from '#web/test/queue-stub'
import { acceptProgram } from '#web/lib/ai/propose'
import type { Suggestion } from '#web/lib/ai/propose'
import { clearAiRouteProgram, setAiRouteProgram } from '#web/lib/ai/route'
import { resolveEntity } from '@spaces/core/writes/entities/resolve'
import { listInboxProgram } from '#web/lib/inbox/queue'
import type { SuggestionRow } from '#web/lib/inbox/queue'
import { handleApiRequest } from '#web/lib/rpc/api'
import { API_PREFIX, CAPTURE_SCHEMA_VERSION } from '#web/lib/rpc/versions'
import { storage } from '@spaces/core/writes/storage'
import { createApiTokenProgram } from '#web/lib/tokens/store'
import { storeCredential } from '@spaces/core/writes/vault'
import { readDeckData, runReadDeck } from './read-deck'

/**
 * SPA-134 — capture extraction, the deck reader's twin pointed at a person.
 * A page posted to `POST /api/v1/capture` with `object` declared is queued
 * on the Read deck job with `capture` set; the job runs `readDeckProgram`
 * against the declared object's registry, anchored on the captured
 * document. On the worker's side of the seam because the job is what is
 * under test (nothing under `lib/` may import `#/worker/**`); the model is
 * `MockLanguageModelV4`, the queue the stub, and nothing reaches a network.
 */
vi.mock('#web/lib/queue', () => import('#web/test/queue-stub'))

const CAPTURE = `http://spaces.test${API_PREFIX}/capture`
const USER = FIXTURE_ACTOR.id
let token = ''

const post = (body: Record<string, unknown>) =>
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

const Captured = z.object({
  documentId: z.string(),
  url: z.string(),
  extraction: z.enum(['queued', 'skipped']),
})
const Failure = z.object({
  error: z.object({ tag: z.string(), message: z.string() }),
})

const profile = (tag: string, extra: Record<string, unknown> = {}) => ({
  captureSchemaVersion: CAPTURE_SCHEMA_VERSION,
  url: `https://www.linkedin.com/in/katya-milev-${tag}/`,
  title: `Katya Milev ${tag}`,
  capturedAt: '2026-09-28T09:30:00Z',
  text: `Katya Milev\nFounder & CEO at Orbital Composites\nSofia, Bulgaria ${tag}`,
  object: 'person',
  ...extra,
})

type Answer = Record<
  string,
  { value: unknown; refs: Array<string>; confidence: number }
>

function mockModel(answer: (prompt: string) => Answer) {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: (options) =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: JSON.stringify(answer(JSON.stringify(options.prompt))),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 20, text: 20, reasoning: undefined },
        },
        warnings: [],
      }),
  })
}

const PERSON_ANSWER = (documentId: string, tag: string): Answer => ({
  _subject: {
    value: {
      name: `Katya Milev ${tag}`,
      role: 'Founder & CEO',
      linkedin: `https://www.linkedin.com/in/katya-milev-${tag}/`,
    },
    refs: [`doc:${documentId}#0`],
    confidence: 0.95,
  },
  job_title: {
    value: 'Founder & CEO',
    refs: [`doc:${documentId}#0`],
    confidence: 0.9,
  },
  location: {
    value: 'Sofia, Bulgaria',
    refs: [`doc:${documentId}#0`],
    confidence: 0.8,
  },
})

async function routeExtract() {
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'extract',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

/** The job the capture queued, run as the worker would, with the model. */
async function runQueued(documentId: string, answer: Answer) {
  const job = enqueued.find(
    (e) => e.name === QUEUES.readDeck && e.data.documentId === documentId,
  )
  expect(job).toBeDefined()
  const data = readDeckData.parse(job?.data)
  const model = mockModel(() => answer)
  await Effect.runPromise(runReadDeck(data, { extractModel: model }))
  return model
}

const onDocument = (documentId: string) =>
  db
    .select()
    .from(suggestion)
    .where(eq(suggestion.entityId, documentId))
    .orderBy(suggestion.createdAt, suggestion.id)

const byKind = (rows: Array<Suggestion>, kind: Suggestion['kind']) =>
  rows.filter((r) => r.kind === kind)

async function cleanBlob(documentId: string) {
  const row = (
    await db
      .select({ sha: document.blobSha })
      .from(document)
      .where(eq(document.entityId, documentId))
  ).at(0)
  if (row?.sha) await storage().delete(row.sha)
}

beforeAll(async () => {
  token = (
    await Effect.runPromise(
      createApiTokenProgram({
        userId: USER,
        name: 'spa134',
        scopes: ['capture:write'],
      }),
    )
  ).token
  // The route is not enough for the capture to queue a read: the lane is
  // routed only once its provider has a live key (`isLaneRouted`).
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-spa134-0000',
    meta: {},
    createdBy: USER,
  })
})

beforeEach(async () => {
  enqueued.length = 0
  await routeExtract()
})

describe('capture extraction (SPA-134)', () => {
  it('queues the one read and answers queued, on the Read deck job keyed on the document', async () => {
    const tag = randomUUID().slice(0, 8)
    const res = await post(profile(tag))
    expect(res.status).toBe(200)
    const body = Captured.parse(await res.json())
    expect(body.extraction).toBe('queued')

    const [people] = await db
      .select({ id: objectDef.id })
      .from(objectDef)
      .where(eq(objectDef.slug, 'people'))
    expect(enqueued.filter((e) => e.name === QUEUES.readDeck)).toEqual([
      {
        name: QUEUES.readDeck,
        data: {
          documentId: body.documentId,
          userId: USER,
          capture: { objectId: people.id },
        },
        options: { singletonKey: body.documentId },
      },
    ])
    await cleanBlob(body.documentId)
  })

  it('a captured profile proposes exactly one identity and one attribute_patch, anchored on the page and citing it', async () => {
    const tag = randomUUID().slice(0, 8)
    const { documentId } = Captured.parse(
      await (await post(profile(tag))).json(),
    )
    const model = await runQueued(documentId, PERSON_ANSWER(documentId, tag))
    expect(model.doGenerateCalls).toHaveLength(1)
    // The person registry, plus the page's subject, as the output schema;
    // the page, with its address, as the context.
    const call = model.doGenerateCalls[0]
    const schema = JSON.stringify(call.responseFormat)
    expect(schema).toContain('_subject')
    expect(schema).toContain('job_title')
    expect(JSON.stringify(call.prompt)).toContain(`katya-milev-${tag}`)

    const rows = await onDocument(documentId)
    expect(rows).toHaveLength(2)
    const [identity] = byKind(rows, 'identity')
    const [patch] = byKind(rows, 'attribute_patch')
    expect(identity.payload).toEqual({
      name: `Katya Milev ${tag}`,
      role: 'Founder & CEO',
      linkedin: `https://www.linkedin.com/in/katya-milev-${tag}/`,
    })
    expect(
      Object.keys(
        z.record(z.string(), z.unknown()).parse(patch.payload),
      ).sort(),
    ).toEqual(['job_title', 'location'])
    for (const row of rows) {
      expect(row.entityId).toBe(documentId)
      expect(row.refs).toEqual([`doc:${documentId}#0`])
      expect(row.status).toBe('open')
    }
    expect(identity.rationale).toContain('from a captured page')

    // One run, named for the object it read the page as — Settings → Usage.
    const run = (
      await db
        .select()
        .from(aiRun)
        .where(eq(aiRun.id, identity.runId ?? ''))
    ).at(0)
    expect(run?.task).toBe('Read captured page · people')
    expect(run?.entityId).toBe(documentId)
    expect(patch.runId).toBe(identity.runId)
    await cleanBlob(documentId)
  })

  it('accepting the identity resolves the person and files the page on them; the patch then applies to that person', async () => {
    const tag = randomUUID().slice(0, 8)
    const { documentId } = Captured.parse(
      await (await post(profile(tag))).json(),
    )
    await runQueued(documentId, PERSON_ANSWER(documentId, tag))
    const rows = await onDocument(documentId)
    const [identity] = byKind(rows, 'identity')
    const [patch] = byKind(rows, 'attribute_patch')
    const actor = { type: 'user' as const, id: USER }

    // Before the identity, the patch has nobody to land on.
    const early = await Effect.runPromise(
      Effect.flip(acceptProgram(patch.id, actor)),
    )
    expect(early._tag).toBe('SuggestionInvalid')
    expect(early.message).toMatch(/Accept the identity first/)

    const accepted = await Effect.runPromise(acceptProgram(identity.id, actor))
    if (accepted.kind !== 'identity') throw new Error('expected an identity')
    expect(accepted.resolved.action).toBe('created')
    const personId = accepted.resolved.entityId
    const person = (
      await db.select().from(entity).where(eq(entity.id, personId))
    ).at(0)
    expect(person?.kind).toBe('person')
    expect(person?.canonicalName).toBe(`Katya Milev ${tag}`)
    // The captured page is attached as the source.
    const filed = await db
      .select()
      .from(link)
      .where(
        and(
          eq(link.fromEntityId, documentId),
          eq(link.toEntityId, personId),
          eq(link.relation, 'tagged_in'),
        ),
      )
    expect(filed).toHaveLength(1)

    await Effect.runPromise(acceptProgram(patch.id, actor))
    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, personId))
    ).at(0)
    expect(after?.values.job_title).toBe('Founder & CEO')
    expect(after?.values.location).toBe('Sofia, Bulgaria')
    await cleanBlob(documentId)
  })

  it('an identity matching a person already held attaches to them, and the patch applies to that person', async () => {
    const tag = randomUUID().slice(0, 8)
    const held = await resolveEntity({
      kind: 'person',
      name: `K. Milev ${tag}`,
      keys: { linkedin: `https://www.linkedin.com/in/katya-milev-${tag}/` },
      source: { class: 'manual' },
    })
    const { documentId } = Captured.parse(
      await (await post(profile(tag))).json(),
    )
    await runQueued(documentId, PERSON_ANSWER(documentId, tag))
    const rows = await onDocument(documentId)
    const actor = { type: 'user' as const, id: USER }
    const accepted = await Effect.runPromise(
      acceptProgram(byKind(rows, 'identity')[0].id, actor),
    )
    if (accepted.kind !== 'identity') throw new Error('expected an identity')
    expect(accepted.resolved.entityId).toBe(held.entityId)
    expect(accepted.resolved.action).toBe('attached')
    await Effect.runPromise(
      acceptProgram(byKind(rows, 'attribute_patch')[0].id, actor),
    )
    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, held.entityId))
    ).at(0)
    expect(after?.values.job_title).toBe('Founder & CEO')
    await cleanBlob(documentId)
  })

  it('re-posting the same capture opens no second suggestion for the same document', async () => {
    const tag = randomUUID().slice(0, 8)
    const company = await resolveEntity({
      kind: 'company',
      name: `Orbital ${tag}`,
      keys: { domain: `orbital-${tag}.example` },
      source: { class: 'manual' },
    })
    // Filed on one record, the same text is the same document (birth's
    // sha + target rule), so the re-post answers the same id.
    const payload = profile(tag, { target: company.entityId })
    const first = Captured.parse(await (await post(payload)).json())
    const second = Captured.parse(await (await post(payload)).json())
    expect(second.documentId).toBe(first.documentId)
    expect(second.extraction).toBe('queued')
    // pg-boss's singleton key refused the second send while the first waits.
    expect(enqueued.filter((e) => e.name === QUEUES.readDeck)).toHaveLength(1)

    await runQueued(first.documentId, PERSON_ANSWER(first.documentId, tag))
    // And a re-post after the first read finished: the job runs again, reads
    // nothing, and writes nothing.
    const again = await runQueued(
      first.documentId,
      PERSON_ANSWER(first.documentId, tag),
    )
    expect(again.doGenerateCalls).toHaveLength(0)
    const rows = await onDocument(first.documentId)
    expect(byKind(rows, 'identity')).toHaveLength(1)
    expect(byKind(rows, 'attribute_patch')).toHaveLength(1)
    // Filed on a company, the page is still read as the person it declared.
    expect(
      await db
        .select({ value: count() })
        .from(suggestion)
        .where(eq(suggestion.entityId, company.entityId)),
    ).toEqual([{ value: 0 }])
    await cleanBlob(first.documentId)
  })

  it('with no route for the extract lane the capture lands, queues nothing, and says extraction was skipped', async () => {
    await Effect.runPromise(clearAiRouteProgram('extract', 'normal'))
    const tag = randomUUID().slice(0, 8)
    const res = await post(profile(tag))
    expect(res.status).toBe(200)
    const body = Captured.parse(await res.json())
    expect(body.extraction).toBe('skipped')
    const doc = await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.entityId, body.documentId))
    expect(doc).toHaveLength(1)
    expect(enqueued.filter((e) => e.name === QUEUES.readDeck)).toEqual([])
    expect(await onDocument(body.documentId)).toEqual([])
    await cleanBlob(body.documentId)
  })

  it('refuses a declared object the registry does not hold, naming the slug, and stores nothing', async () => {
    const tag = randomUUID().slice(0, 8)
    const [{ value: before }] = await db
      .select({ value: count() })
      .from(document)
    const res = await post(profile(tag, { object: `startups-${tag}` }))
    expect(res.status).toBe(400)
    const { error } = Failure.parse(await res.json())
    expect(error.tag).toBe('BadRequest')
    expect(error.message).toContain(`startups-${tag}`)
    const [{ value: after }] = await db
      .select({ value: count() })
      .from(document)
    expect(after).toBe(before)
    expect(enqueued).toEqual([])
  })

  it('a company page is a patch only — the identity schema claims people — and applies to the company it is filed on', async () => {
    const tag = randomUUID().slice(0, 8)
    const payload = {
      ...profile(tag, { object: 'company' }),
      url: `https://www.linkedin.com/company/orbital-${tag}/`,
      title: `Orbital Composites ${tag}`,
      text: `Orbital Composites builds carbon-fibre tanks. Founded 2021. ${tag}`,
    }
    const { documentId } = Captured.parse(await (await post(payload)).json())
    await runQueued(documentId, {
      description: {
        value: 'Carbon-fibre tanks',
        refs: [`doc:${documentId}#0`],
        confidence: 0.9,
      },
      founded_year: {
        value: 2021,
        refs: [`doc:${documentId}#0`],
        confidence: 0.9,
      },
    })
    const rows = await onDocument(documentId)
    expect(rows.map((r) => r.kind)).toEqual(['attribute_patch'])
    const actor = { type: 'user' as const, id: USER }
    const unfiled = await Effect.runPromise(
      Effect.flip(acceptProgram(rows[0].id, actor)),
    )
    expect(unfiled.message).toMatch(/File the page on a company first/)

    const company = await resolveEntity({
      kind: 'company',
      name: `Orbital Composites ${tag}`,
      keys: { domain: `orbital-co-${tag}.example` },
      source: { class: 'manual' },
    })
    await db.insert(link).values({
      fromEntityId: documentId,
      toEntityId: company.entityId,
      relation: 'tagged_in',
      source: 'manual',
    })
    await Effect.runPromise(acceptProgram(rows[0].id, actor))
    const after = (
      await db
        .select({ values: entity.values })
        .from(entity)
        .where(eq(entity.id, company.entityId))
    ).at(0)
    expect(after?.values.description).toBe('Carbon-fibre tanks')
    await cleanBlob(documentId)
  })

  it('/inbox draws the capture as an ownerless card headed by the page, its fields through the person registry', async () => {
    const tag = randomUUID().slice(0, 8)
    const { documentId } = Captured.parse(
      await (await post(profile(tag))).json(),
    )
    await runQueued(documentId, PERSON_ANSWER(documentId, tag))
    const rows = await Effect.runPromise(
      listInboxProgram({ record: documentId }),
    )
    expect(rows).toHaveLength(1)
    const card = rows[0]
    if (card.kind !== 'suggestion') throw new Error('expected a card')
    const expected: Pick<SuggestionRow, 'id' | 'page'> = {
      id: documentId,
      page: {
        title: `Katya Milev ${tag}`,
        url: `https://www.linkedin.com/in/katya-milev-${tag}/`,
      },
    }
    expect({ id: card.id, page: card.page }).toEqual(expected)
    const patch = card.suggestions.find((s) => s.kind === 'attribute_patch')
    expect(patch?.fields?.map((f) => [f.slug, f.name]).sort()).toEqual([
      ['job_title', 'Job title'],
      ['location', 'Location'],
    ])
    for (const item of card.suggestions)
      expect(item.citations.map((c) => c.ref)).toEqual([`doc:${documentId}#0`])
    await cleanBlob(documentId)
  })
})

// ---------- one extract program, not two ----------

// Both source trees (SPA-181): the deck reader's program is apps/web's, the
// job that calls it is apps/worker's. Paths are repo-relative.
const ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../..',
)
const TREES = ['apps/web/src', 'apps/worker/src']

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name)
    if (d.isDirectory()) return sources(path)
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : []
  })
}

const files = TREES.flatMap((tree) => sources(join(ROOT, tree))).map(
  (path) => ({
    path: relative(ROOT, path),
    text: readFileSync(path, 'utf8'),
  }),
)

const calls = (text: string, fn: string) =>
  text.match(new RegExp(`\\b${fn}\\(`, 'g'))?.length ?? 0

describe('one extract program, not two (SPA-134)', () => {
  it('the registry-compiled extract call is made once, in the deck reader, which reads company, deal and person alike', () => {
    // `schemaFor(registry)` handed to the extraction cache: the call ai-6
    // makes for a company and a deal (`lib/ai/read-deck.test.ts`, "reads a
    // deck filed on a company and a deal as two calls") and a capture makes
    // for a person. One site, not a fork per object.
    const extracting = files.filter(
      (f) =>
        calls(f.text, 'cachedExtractProgram') > 0 &&
        calls(f.text, 'schemaFor') > 0,
    )
    expect(extracting.map((f) => f.path)).toEqual([
      'apps/web/src/lib/ai/read-deck.ts',
    ])
    const reader = extracting[0]
    expect(calls(reader.text, 'cachedExtractProgram')).toBe(1)
  })

  it('the capture path reaches it only through readDeckProgram', () => {
    const job = files.find(
      (f) => f.path === 'apps/worker/src/jobs/read-deck.ts',
    )
    const capture = files.find(
      (f) => f.path === 'apps/web/src/lib/rpc/capture.ts',
    )
    for (const f of [job, capture]) {
      expect(f).toBeDefined()
      expect(
        calls(f?.text ?? '', 'cachedExtractProgram') +
          calls(f?.text ?? '', 'completeProgram') +
          calls(f?.text ?? '', 'schemaFor'),
      ).toBe(0)
    }
    // One call site in the job, whatever it reads: a deck or a page.
    expect(calls(job?.text ?? '', 'readDeckProgram')).toBe(1)
    expect(calls(capture?.text ?? '', 'enqueueCaptureReadProgram')).toBe(1)
  })
})
