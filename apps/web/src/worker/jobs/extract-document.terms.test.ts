import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QUEUES } from '@spaces/core/queue/names'
import { minimalPdf } from '#/test/minimal-pdf'
import { JobContext } from '../run-job'
import { ExtractionStore, extractDocument } from './extract-document'

/**
 * SPA-34's document half: extraction of a deck that mentions a glossary term
 * links the document to the term, and the link survives re-extraction.
 *
 * The job runs under its real `ExtractionStore` layer — `markExtracted` is
 * where the sync lives, in the same transaction as the text — exactly as
 * `extract-document.arrival.test.ts` runs it. It sits beside the worker for
 * the same reason that file does: nothing under `lib/` may import it.
 */
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

beforeEach(async () => {
  const { enqueued } = await import('#/test/queue-stub')
  enqueued.length = 0
})

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function makeSpace(name: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity, space } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'space', canonicalName: name })
    .returning({ id: entity.id })
  const own = `s${randomUUID().replace(/-/g, '').slice(0, 12)}`
  await db.insert(space).values({ entityId: ent.id, slug: own, path: own })
  return ent.id
}

async function makeTerm(name: string, spaceId: string | null) {
  const { db } = await import('@spaces/db')
  const { entity, term } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'term', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(term).values({ entityId: ent.id, name, spaceId })
  return ent.id
}

function extract(documentId: string, attempt: string) {
  return Effect.runPromise(
    Effect.provide(
      Effect.provideService(
        extractDocument.run({ documentId }),
        JobContext,
        JobContext.of({
          queue: QUEUES.extractDocument,
          jobId: `test-${attempt}`,
          attempt: 1,
          isFinalAttempt: true,
        }),
      ),
      ExtractionStore.layer,
    ),
  )
}

async function mentionsFrom(fromId: string) {
  const { db } = await import('@spaces/db')
  const { link } = await import('@spaces/db/schema')
  const { and, eq } = await import('drizzle-orm')
  return db
    .select({
      id: link.id,
      to: link.toEntityId,
      source: link.source,
      createdAt: link.createdAt,
    })
    .from(link)
    .where(and(eq(link.fromEntityId, fromId), eq(link.relation, 'mentions')))
}

describe('document extraction links the glossary terms the deck mentions', () => {
  it('links the document, and the link survives re-extraction', async () => {
    const tag = randomUUID().slice(0, 8)
    const dataCentres = await makeSpace(`Data centers ${tag}`)
    const bio = await makeSpace(`Bio ${tag}`)
    const pue = await makeTerm('PUE', dataCentres)
    // Mentioned in the deck, but scoped to a space the deck is not filed in.
    await makeTerm('IND', bio)

    const { intakeDocumentProgram } = await import('#/lib/documents/intake')
    const { id } = await Effect.runPromise(
      intakeDocumentProgram({
        stream: Readable.from([
          minimalPdf(`Fleet PUE 1.08 and no IND filing ${tag}`),
        ]),
        filename: `Deck-${tag}.pdf`,
        mime: 'application/pdf',
        declaredSize: null,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'space', entityId: dataCentres }],
        actor: { userId: await actorId() },
      }),
    )

    await extract(id, `${tag}-1`)
    const first = await mentionsFrom(id)
    expect(first).toEqual([
      expect.objectContaining({ to: pue, source: 'extracted' }),
    ])

    // Re-extraction runs the sync again over the same text: the same row
    // stands, not a delete-and-reinsert that happens to look alike.
    await extract(id, `${tag}-2`)
    expect(await mentionsFrom(id)).toEqual(first)

    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const row = (
      await db
        .select({
          blobSha: document.blobSha,
          extractionStatus: document.extractionStatus,
        })
        .from(document)
        .where(eq(document.entityId, id))
    ).at(0)
    expect(row?.extractionStatus).toBe('done')

    const { storage } = await import('#/lib/storage')
    if (row?.blobSha) await storage().delete(row.blobSha)
  })
})
