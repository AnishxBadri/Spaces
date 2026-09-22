import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobContext } from '../run-job'
import { clipDocument } from './clip-document'

/**
 * document.clip driven end to end (SPA-117) — the row from `clipUrlProgram`,
 * a stubbed `fetch`, and the four outcomes the acceptance criteria name.
 *
 * `fetch` is stubbed and never real: the whole point of the guard is that
 * this job talks to somebody else's server, and a test that actually did so
 * would be slow, flaky and a different assertion every week. What is real is
 * everything else — the document row, the readability pass over fixture HTML,
 * the text + tsv write, and the entity rename.
 *
 * It lives beside the job rather than beside `clip.ts` for the reason
 * `dedupe-sweep.test.ts` does: `src/lib/**` may not import `src/worker/**`
 * (spec §2's forbidden edge, enforced by `import/no-restricted-paths`), and
 * the whole file drives the job.
 *
 * The test databases carry no `pgboss` schema and birth enqueues; see
 * `#/test/queue-stub`.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

afterEach(() => {
  vi.unstubAllGlobals()
})

const ARTICLE = `
  <!doctype html>
  <html>
    <head><title>Electrolyser stacks are the bottleneck</title></head>
    <body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <article>
        <h1>Electrolyser stacks are the bottleneck</h1>
        <p>
          The hydrogen story is usually told as a story about renewable
          electricity, but the binding constraint in 2026 is manufacturing
          capacity for electrolyser stacks, and the iridium loading of the
          membranes in particular. A gigawatt of PEM capacity takes roughly
          a quarter of a tonne of iridium at today's loadings.
        </p>
        <p>
          Alkaline stacks avoid the iridium problem and buy it back as a
          slower ramp rate, which matters when the input is a wind farm
          rather than a grid connection.
        </p>
      </article>
      <footer>Copyright someone</footer>
    </body>
  </html>
`

/** A `Response` the stub hands back. */
function response(
  init: { status: number; headers?: Record<string, string> },
  body?: string,
): Response {
  return new Response(body ?? null, {
    status: init.status,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  })
}

function stubFetch(answer: (url: string) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => Promise.resolve(answer(url))),
  )
}

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** The row the web half writes, which is where every test below starts. */
async function aClip(url: string): Promise<string> {
  const { Effect } = await import('effect')
  const { clipUrlProgram } = await import('#/lib/documents/clip')
  const { id } = await Effect.runPromise(
    clipUrlProgram({
      url,
      fileAgainst: [],
      actor: { userId: await actorId() },
    }),
  )
  return id
}

/** Exactly what `runJob` would run, minus the ledger it writes around it. */
async function runClip(documentId: string): Promise<'ok' | string> {
  const { Effect, Exit, Cause, Option } = await import('effect')
  const { QUEUES } = await import('@spaces/core/queue/names')
  const exit = await Effect.runPromiseExit(
    Effect.provideService(
      clipDocument.run({ documentId }),
      JobContext,
      JobContext.of({
        queue: QUEUES.clipDocument,
        jobId: `test-${documentId}`,
        attempt: 1,
        isFinalAttempt: true,
      }),
    ),
  )
  if (Exit.isSuccess(exit)) return 'ok'
  const failure = Cause.findErrorOption(exit.cause)
  // A typed failure, never a defect: contract 2 says an uncaught throw past
  // the wrapper is a container death, so this assertion is load-bearing.
  expect(Option.isSome(failure)).toBe(true)
  if (Option.isNone(failure)) throw new Error('unreachable')
  return failure.value._tag
}

async function rowOf(id: string) {
  const { db } = await import('@spaces/db')
  const { document, entity } = await import('@spaces/db/schema')
  const { eq, sql } = await import('drizzle-orm')
  return (
    await db
      .select({
        status: document.extractionStatus,
        error: document.extractionError,
        text: document.extractedText,
        filename: document.filename,
        canonicalName: entity.canonicalName,
        // The tsv must be written by the same statement the text was, or
        // search answers rows whose text says otherwise.
        tsvWords: sql<number>`coalesce(length(${document.tsv}::text), 0)`,
      })
      .from(document)
      .innerJoin(entity, eq(entity.id, document.entityId))
      .where(eq(document.entityId, id))
  ).at(0)
}

describe('clipDocument', () => {
  it('writes text, tsv and the article title on a good HTML page', async () => {
    const url = 'https://example.com/electrolysers'
    stubFetch(() =>
      response(
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
        ARTICLE,
      ),
    )

    const id = await aClip(url)
    expect(await runClip(id)).toBe('ok')

    const row = await rowOf(id)
    expect(row?.status).toBe('done')
    expect(row?.error).toBeNull()
    // A phrase from the body — which is what makes the row findable in ⌘K.
    expect(row?.text).toContain('iridium loading of the membranes')
    // And not the chrome readability is supposed to have dropped.
    expect(row?.text).not.toContain('Copyright someone')
    expect(row?.tsvWords).toBeGreaterThan(0)
    // The row was named by its URL and is now named by the article.
    expect(row?.canonicalName).toBe('Electrolyser stacks are the bottleneck')
    expect(row?.filename).toBe('Electrolyser stacks are the bottleneck')
  })

  it('is findable by a phrase from the body through the tsv', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { and, eq, sql } = await import('drizzle-orm')
    stubFetch(() =>
      response(
        { status: 200, headers: { 'content-type': 'text/html' } },
        ARTICLE,
      ),
    )
    const id = await aClip('https://example.com/findable')
    expect(await runClip(id)).toBe('ok')

    const hits = await db
      .select({ id: document.entityId })
      .from(document)
      .where(
        and(
          eq(document.entityId, id),
          sql`${document.tsv} @@ plainto_tsquery('english', 'iridium electrolyser membranes')`,
        ),
      )
    expect(hits.map((h) => h.id)).toEqual([id])
  })

  it('records a non-HTML content-type as unsupported, naming the type', async () => {
    stubFetch(() =>
      response(
        { status: 200, headers: { 'content-type': 'application/pdf' } },
        '%PDF-1.7',
      ),
    )
    const id = await aClip('https://example.com/deck.pdf')
    // Permanent, not retryable: the page will be a PDF next time too.
    // docsurf-10b is what turns this branch into a blob through intake.
    expect(await runClip(id)).toBe('JobPermanent')

    const row = await rowOf(id)
    expect(row?.status).toBe('unsupported')
    expect(row?.error).toContain('application/pdf')
    expect(row?.text).toBeNull()
  })

  it('records a guard refusal as failed with the reason', async () => {
    const calls: Array<string> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url)
        return Promise.resolve(
          response({
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
        )
      }),
    )
    const id = await aClip('https://example.com/looks-fine')
    expect(await runClip(id)).toBe('JobPermanent')

    const row = await rowOf(id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('169.254.169.254')
    expect(row?.error).toContain('link-local')
    // The public hop was fetched; the metadata endpoint never was.
    expect(calls).toEqual(['https://example.com/looks-fine'])
  })

  it('records a network failure as failed rather than retrying it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    )
    const id = await aClip('https://example.com/down')
    expect(await runClip(id)).toBe('JobPermanent')

    const row = await rowOf(id)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain('ECONNREFUSED')
  })

  it('records a page with no article as unsupported', async () => {
    stubFetch(() =>
      response(
        { status: 200, headers: { 'content-type': 'text/html' } },
        '<html><head><title>Nothing here</title></head><body><nav>menu</nav></body></html>',
      ),
    )
    const id = await aClip('https://example.com/empty')
    expect(await runClip(id)).toBe('JobPermanent')

    const row = await rowOf(id)
    expect(row?.status).toBe('unsupported')
    expect(row?.error).toContain('No readable article text')
  })

  it('completes quietly when the document vanished before the job ran', async () => {
    const { randomUUID } = await import('node:crypto')
    stubFetch(() => response({ status: 200 }))
    expect(await runClip(randomUUID())).toBe('ok')
  })
})
