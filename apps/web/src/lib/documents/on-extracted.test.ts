import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Effect, Exit } from 'effect'
import { eq, isNotNull } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { aiRoute, credential, document, entity } from '@spaces/db/schema'
import { guessDocumentKind } from '@spaces/core/documents'
import type { DocumentKind } from '@spaces/core/documents'
import { QUEUES } from '@spaces/core/queue/names'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { enqueued } from '#/test/queue-stub'
import { setAiRouteProgram } from '#/lib/ai/route'
import { storeCredential } from '@spaces/core/writes/vault'
import { birthDocumentProgram } from './birth'
import { onDocumentExtracted } from './on-extracted'

vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * SPA-62, the seam: `document.extracted` has one author. Whatever runs
 * after an extraction is enqueued by `onDocumentExtracted`, which is called
 * from extractDocument's success path and nowhere else — the grep at the
 * bottom holds both halves. Between them: `document.embed` always, and
 * `document.classify` only for a document still at `other` with the
 * classify lane routed.
 *
 * SPA-94 is the seam's second tenant, as SPA-62's body named it ("ai-21's
 * vision write"): the vision job reaches `onDocumentExtracted` through the
 * *store* — `ExtractionStore.onExtracted`, whose layer is the one call site
 * below — so the single-call-site assertion is unchanged, and the store
 * seam's callers are pinned by name beside it.
 */

const USER = FIXTURE_ACTOR.id

/**
 * A document born the way an upload is — `guessDocumentKind(filename)`
 * unless the caller says otherwise, as a bound folder would — then given
 * the text an extraction leaves behind.
 */
async function extracted(
  filename: string,
  opts: { kind?: DocumentKind; sourcePath?: string; sensitive?: boolean } = {},
): Promise<string> {
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: null,
      filename,
      mime: 'application/pdf',
      sizeBytes: 1024,
      kind: opts.kind ?? guessDocumentKind(filename),
      sourceClass: 'manual',
      sourceRef: null,
      provenance:
        opts.sourcePath === undefined ? {} : { sourcePath: opts.sourcePath },
      fileAgainst: [],
      actor: { userId: USER },
    }),
  )
  // Exempt from the one-writer rule: the fixture stands in for the job
  // whose tail this file tests.
  await db
    .update(document)
    .set({ extractionStatus: 'done', extractedText: 'Holder, Shares, %' })
    .where(eq(document.entityId, id))
  if (opts.sensitive === true)
    await db.update(entity).set({ sensitive: true }).where(eq(entity.id, id))
  enqueued.length = 0
  return id
}

async function routeClassify() {
  await storeCredential({
    scope: 'workspace',
    provider: 'anthropic',
    kind: 'llm',
    secret: 'sk-ant-test-classify-0000',
    meta: {},
    createdBy: USER,
  })
  await Effect.runPromise(
    setAiRouteProgram({
      lane: 'classify',
      sensitivity: 'normal',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  )
}

const sent = () => enqueued.map((e) => e.name)

beforeEach(async () => {
  enqueued.length = 0
  await db.delete(aiRoute).where(isNotNull(aiRoute.id))
  await db.delete(credential).where(isNotNull(credential.id))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('onDocumentExtracted — classify unrouted', () => {
  it('with no provider configured at all: embed only, no log, no error', async () => {
    const id = await extracted('Acme holdings.pdf')
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')

    const exit = await Effect.runPromiseExit(onDocumentExtracted(id))

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(sent()).toEqual([QUEUES.embedDocument])
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('onDocumentExtracted — classify routed', () => {
  it('enqueues classify for a document left at other, keyed on it', async () => {
    await routeClassify()
    const id = await extracted('Acme holdings.pdf')
    await Effect.runPromise(onDocumentExtracted(id))

    expect(sent()).toEqual([QUEUES.embedDocument, QUEUES.classifyDocument])
    expect(enqueued[1]).toEqual({
      name: QUEUES.classifyDocument,
      data: { documentId: id },
      options: { singletonKey: id },
    })
  })

  it('never for a kind the filename gave it', async () => {
    await routeClassify()
    expect(guessDocumentKind('Acme cap table.xlsx')).toBe('cap_table')
    const id = await extracted('Acme cap table.xlsx')
    await Effect.runPromise(onDocumentExtracted(id))
    expect(sent()).toEqual([QUEUES.embedDocument])
  })

  it('never for a kind a bound folder gave it', async () => {
    await routeClassify()
    // The filename says nothing; the folder it arrived from did.
    const id = await extracted('Acme holdings.pdf', {
      kind: 'dd',
      sourcePath: 'Data room/Diligence/Acme holdings.pdf',
    })
    await Effect.runPromise(onDocumentExtracted(id))
    expect(sent()).toEqual([QUEUES.embedDocument])
  })

  it('not for a sensitive document when only the normal cell is routed', async () => {
    await routeClassify()
    const id = await extracted('Acme holdings.pdf', { sensitive: true })
    await Effect.runPromise(onDocumentExtracted(id))
    expect(sent()).toEqual([QUEUES.embedDocument])
  })
})

// ---------- the single author ----------

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name)
    if (d.isDirectory()) return sources(path)
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path] : []
  })
}

const files = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}))

describe('document.extracted has one author', () => {
  it('onDocumentExtracted is called from extract-document.ts, once, and nowhere else', () => {
    const calls = files.flatMap((f) =>
      [...f.text.matchAll(/\bonDocumentExtracted\(/g)].map(() => f.path),
    )
    // The definition is `Effect.fn('onDocumentExtracted')(…)` and does not
    // match; what is left is the one call on extraction's success path.
    expect(calls).toEqual(['worker/jobs/extract-document.ts'])
  })

  it('the store seam is called by extraction and by the vision write, and nobody else', () => {
    // `ExtractionStore.onExtracted` is `onDocumentExtracted` behind the
    // job's Layer. Extraction calls it on its success path; the vision job
    // (SPA-94) calls it after writing through the same `markExtracted`,
    // because a scanned page read by a model is extraction too.
    const calls = files.flatMap((f) =>
      [...f.text.matchAll(/\bstore\.onExtracted\(/g)].map(() => f.path),
    )
    expect(calls.sort()).toEqual([
      'worker/jobs/extract-document.ts',
      'worker/jobs/vision-document.ts',
    ])
  })

  it('no other file enqueues a follow-on lane of an extraction', () => {
    const followOn = /enqueue\(\s*QUEUES\.(embedDocument|classifyDocument)\b/g
    const enqueuers = files.flatMap((f) =>
      [...f.text.matchAll(followOn)].map((m) => `${f.path} ${m[1]}`),
    )
    expect(enqueuers.sort()).toEqual([
      'lib/documents/on-extracted.ts classifyDocument',
      'lib/documents/on-extracted.ts embedDocument',
    ])
  })
})
