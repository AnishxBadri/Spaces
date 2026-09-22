import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { minimalPdf } from '#/test/minimal-pdf'
import { JobContext } from '../run-job'
import { CLIP_MAX_BYTES, clipDocument } from './clip-document'

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

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

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

/**
 * A `Response` the stub hands back. Bytes as well as text, for the PDF lane —
 * copied into a plain `Uint8Array` because a Node `Buffer` is backed by a
 * pooled `ArrayBufferLike`, which `BodyInit` does not accept.
 */
function response(
  init: { status: number; headers?: Record<string, string> },
  body?: string | Uint8Array,
): Response {
  const payload =
    body === undefined
      ? null
      : typeof body === 'string'
        ? body
        : new Uint8Array(body)
  return new Response(payload, {
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
async function aClip(
  url: string,
  spaceId?: string | undefined,
): Promise<string> {
  const { Effect } = await import('effect')
  const { clipUrlProgram } = await import('#/lib/documents/clip')
  const { id } = await Effect.runPromise(
    clipUrlProgram({
      url,
      fileAgainst:
        spaceId === undefined ? [] : [{ kind: 'space', entityId: spaceId }],
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
        blobSha: document.blobSha,
        sizeBytes: document.sizeBytes,
        mime: document.mime,
        kind: document.kind,
        url: document.url,
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

  it('records a content-type that is neither HTML nor PDF as unsupported, naming the type', async () => {
    stubFetch(() =>
      response(
        { status: 200, headers: { 'content-type': 'application/zip' } },
        'PK',
      ),
    )
    const id = await aClip('https://example.com/dataroom.zip')
    // Permanent, not retryable: the page will be a zip next time too.
    expect(await runClip(id)).toBe('JobPermanent')

    const row = await rowOf(id)
    expect(row?.status).toBe('unsupported')
    expect(row?.error).toContain('application/zip')
    expect(row?.text).toBeNull()
    expect(row?.blobSha).toBeNull()
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

  /**
   * docsurf-10b — §3.1 entry point 5's PDF snapshot. The assertion that
   * matters is not "a PDF is handled" but "the row is indistinguishable from
   * an upload's": a digest, bytes under it in the store, a size we counted,
   * and `document.extract` holding the job — the pipeline a deck dragged onto
   * the Files tab walks, reached from a URL.
   */
  describe('a PDF response', () => {
    it('hashes, stores and enqueues extraction — the same row shape as an upload', async () => {
      const { storage } = await import('#/lib/storage')
      const { QUEUES } = await import('@spaces/core/queue/names')
      const { enqueued } = await import('#/test/queue-stub')

      const bytes = minimalPdf('Ohmium seed deck')
      const sha = createHash('sha256').update(bytes).digest('hex')
      stubFetch(() =>
        response(
          { status: 200, headers: { 'content-type': 'application/pdf' } },
          bytes,
        ),
      )

      const id = await aClip('https://example.com/decks/seed-deck.pdf')
      // `clipUrlProgram` enqueued this very job; what is under test is what
      // the job enqueues next, so the record starts from here.
      enqueued.length = 0
      // Not a refusal any more: the job succeeds, as an HTML clip does.
      expect(await runClip(id)).toBe('ok')

      const row = await rowOf(id)
      expect(row?.blobSha).toBe(sha)
      expect(row?.sizeBytes).toBe(bytes.length)
      expect(row?.mime).toBe('application/pdf')
      // Born `article` — a pasted link usually is one — and filed as what it
      // turned out to be, guessed off the URL's last segment.
      expect(row?.kind).toBe('deck')
      // Handed to the ordinary extractor, not marked done here.
      expect(row?.status).toBe('pending')
      expect(row?.error).toBeNull()
      // The address stays on the row: it is still where this came from.
      expect(row?.url).toBe('https://example.com/decks/seed-deck.pdf')

      expect(await storage().exists(sha)).toBe(true)
      expect(enqueued).toEqual([
        { name: QUEUES.extractDocument, data: { documentId: id } },
      ])

      await storage().delete(sha)
    })

    it('reads the magic bytes when the server mislabels the type', async () => {
      const { storage } = await import('#/lib/storage')
      const bytes = minimalPdf('Mislabelled')
      const sha = createHash('sha256').update(bytes).digest('hex')
      stubFetch(() =>
        response(
          {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          },
          bytes,
        ),
      )

      // No extension either, so `%PDF-` is the only evidence there is.
      const id = await aClip('https://example.com/download?doc=9')
      expect(await runClip(id)).toBe('ok')

      const row = await rowOf(id)
      expect(row?.blobSha).toBe(sha)
      expect(row?.mime).toBe('application/pdf')
      // Nothing in that URL reads like a deck; `other` is the honest guess.
      expect(row?.kind).toBe('other')

      await storage().delete(sha)
    })

    it('shares one blob with an identical uploaded file', async () => {
      const { storage } = await import('#/lib/storage')
      const { blobIsReferenced } = await import('#/lib/documents/blob-refs')
      const { intakeDocumentProgram } = await import('#/lib/documents/intake')
      const { Effect } = await import('effect')

      const bytes = minimalPdf('The very same deck')
      const sha = createHash('sha256').update(bytes).digest('hex')

      // The upload lane first, so the clip finds the digest already stored.
      const uploaded = await Effect.runPromise(
        intakeDocumentProgram({
          stream: Readable.from([bytes]),
          filename: 'seed-deck.pdf',
          mime: 'application/pdf',
          declaredSize: null,
          kind: 'deck',
          sourceClass: 'manual',
          sourceRef: null,
          provenance: {},
          fileAgainst: [],
          actor: { userId: await actorId() },
        }),
      )

      stubFetch(() =>
        response(
          { status: 200, headers: { 'content-type': 'application/pdf' } },
          bytes,
        ),
      )
      const clipped = await aClip('https://example.com/decks/seed-deck.pdf')
      expect(await runClip(clipped)).toBe('ok')

      // Two documents — the clip's row already existed, so §3.4's row-level
      // dedupe is not available to it and was never attempted — and **one**
      // blob, which is the dedupe content addressing actually buys.
      expect(clipped).not.toBe(uploaded.id)
      expect((await rowOf(clipped))?.blobSha).toBe(sha)
      expect(await storage().exists(sha)).toBe(true)
      expect(await blobIsReferenced(sha)).toBe(true)

      await storage().delete(sha)
    })

    it('records a PDF over the byte cap as failed, storing nothing', async () => {
      const { storage } = await import('#/lib/storage')
      const { enqueued } = await import('#/test/queue-stub')

      // One byte past the cap. `guardedFetch` counts off the stream, so the
      // refusal happens before the job ever sees bytes to hash.
      const oversize = Buffer.concat([
        minimalPdf('Too big'),
        Buffer.alloc(CLIP_MAX_BYTES, 0x20),
      ])
      const sha = createHash('sha256').update(oversize).digest('hex')
      stubFetch(() =>
        response(
          { status: 200, headers: { 'content-type': 'application/pdf' } },
          oversize,
        ),
      )

      const id = await aClip('https://example.com/decks/enormous.pdf')
      enqueued.length = 0
      expect(await runClip(id)).toBe('JobPermanent')

      const row = await rowOf(id)
      expect(row?.status).toBe('failed')
      expect(row?.error).toContain(String(CLIP_MAX_BYTES))
      // Nothing partially stored, and nothing handed to the extractor.
      expect(row?.blobSha).toBeNull()
      expect(row?.sizeBytes).toBeNull()
      expect(await storage().exists(sha)).toBe(false)
      expect(enqueued).toEqual([])
    })
  })

  /**
   * The reader's half of docsurf-10b. Every surface that renders a document
   * row decides between Download and "Open source" off two columns, so the
   * two lanes that serve those surfaces have to carry both — a shape a
   * component test cannot check, because a column missing from a loader is
   * missing before React is reached.
   *
   * Both rows are made the real way: `clipUrlProgram` writes them and the
   * job fills them in, so what is asserted is what the product will hold.
   */
  describe('the shape the reading surfaces get back', () => {
    it('carries blobSha and url on the shelf and the space lane, for an article and for a PDF', async () => {
      const { randomUUID } = await import('node:crypto')
      const { Effect } = await import('effect')
      const { createSpaceRow } = await import('#/lib/server/shared')
      const { listDocumentsProgram } = await import('#/lib/documents/shelf')
      const { spaceSourcesProgram } =
        await import('#/lib/documents/space-sources')
      const { storage } = await import('#/lib/storage')

      const tag = randomUUID().slice(0, 8)
      const spaceId = await createSpaceRow(
        `Hydrogen ${tag}`,
        null,
        await actorId(),
      )

      const articleUrl = `https://example.com/electrolysers-${tag}`
      const deckUrl = `https://example.com/decks/seed-deck-${tag}.pdf`
      const bytes = minimalPdf(`Seed deck ${tag}`)
      const sha = createHash('sha256').update(bytes).digest('hex')

      // One stub for both clips, answering by URL — the two rows have to
      // exist side by side for the assertion to mean anything.
      stubFetch((url) =>
        url === deckUrl
          ? response(
              { status: 200, headers: { 'content-type': 'application/pdf' } },
              bytes,
            )
          : response(
              { status: 200, headers: { 'content-type': 'text/html' } },
              ARTICLE,
            ),
      )

      const articleId = await aClip(articleUrl, spaceId)
      expect(await runClip(articleId)).toBe('ok')
      const deckId = await aClip(deckUrl, spaceId)
      expect(await runClip(deckId)).toBe('ok')

      const shelf = await Effect.runPromise(
        listDocumentsProgram({ filed: 'all' }),
      )
      const onShelf = new Map(shelf.map((r) => [r.id, r]))
      // The article: an address and no bytes, which is what makes the row's
      // control "Open source" rather than a download that throws.
      expect(onShelf.get(articleId)).toMatchObject({
        blobSha: null,
        url: articleUrl,
      })
      // The PDF: a digest, so the same row renders exactly as an upload.
      expect(onShelf.get(deckId)).toMatchObject({ blobSha: sha, url: deckUrl })

      const sources = await Effect.runPromise(spaceSourcesProgram(spaceId))
      const inSpace = new Map(sources.map((r) => [r.id, r]))
      expect(inSpace.get(articleId)).toMatchObject({
        blobSha: null,
        url: articleUrl,
      })
      expect(inSpace.get(deckId)).toMatchObject({ blobSha: sha, url: deckUrl })

      await storage().delete(sha)
    })
  })

  it('completes quietly when the document vanished before the job ran', async () => {
    const { randomUUID } = await import('node:crypto')
    stubFetch(() => response({ status: 200 }))
    expect(await runClip(randomUUID())).toBe('ok')
  })
})
