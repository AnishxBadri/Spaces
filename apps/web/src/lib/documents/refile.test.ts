import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

// The test databases carry no `pgboss` schema, and the birth of a document
// enqueues extraction — see `#/test/queue-stub`.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Re-filing a document (SPA-50), against the test database.
 *
 * §3.4's rule is the one worth pinning: a document is filed in N places, so
 * the deck lives on the company *and* the deal from one blob, and taking one
 * edge away must leave the other exactly as it was. The second rule is the
 * one an implementation is most likely to get wrong on its own: **removing
 * the last edge is not a delete** — the row, the blob and the extracted text
 * all stay, and the document is simply unfiled.
 *
 * The programs are driven directly rather than through their server fns, for
 * `documents-filing.test.ts`'s reason: a server fn wants a request context no
 * test has. Imports are dynamic for the same reason as the rest of the
 * DB-coupled suite — `@spaces/db` builds its pool from `DATABASE_URL` at
 * import time and `vitest.setup.ts` rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

async function aCompany(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Ohmium ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** A deal is an entity and its attribute values — there is no `deal` table. */
async function aDeal(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'deal', canonicalName: `Ohmium Series B ${tag}` })
    .returning({ id: entity.id })
  return ent.id
}

async function aSpace(tag: string): Promise<string> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return createSpaceRow(`Hydrogen ${tag}`, null, await actorId())
}

/** Real bytes, so "the blob is still there" is about a file and not a call. */
async function aBlob(tag: string): Promise<string> {
  const { storage } = await import('#/lib/storage')
  const bytes = Buffer.from(`deck ${tag}\n`, 'utf8')
  const sha = createHash('sha256').update(bytes).digest('hex')
  await storage().put(sha, bytes, { mime: 'text/plain' })
  return sha
}

async function aFiledDeck(tag: string, companyId: string): Promise<string> {
  const { birthDocumentProgram } = await import('./birth')
  const { id } = await Effect.runPromise(
    birthDocumentProgram({
      blobSha: await aBlob(tag),
      filename: `deck-${tag}.pdf`,
      mime: 'application/pdf',
      sizeBytes: 1024,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: [{ kind: 'record', entityId: companyId }],
      actor: { userId: await actorId() },
    }),
  )
  return id
}

/** The join the Files tab makes: which records list this document. */
async function filesTabsShowing(documentId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { entity, link } = await import('@spaces/db/schema')
  const { and, eq, isNull } = await import('drizzle-orm')
  const rows = await db
    .select({ to: link.toEntityId })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.toEntityId))
    .where(
      and(
        eq(link.fromEntityId, documentId),
        eq(link.relation, 'tagged_in'),
        isNull(entity.mergedIntoId),
      ),
    )
  return rows.map((r) => r.to).sort()
}

async function spacesHolding(documentId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { entitySpace } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db
    .select({ space: entitySpace.spaceId })
    .from(entitySpace)
    .where(eq(entitySpace.entityId, documentId))
  return rows.map((r) => r.space).sort()
}

async function verbsOn(documentId: string): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { activity } = await import('@spaces/db/schema/activity')
  const { eq, or } = await import('drizzle-orm')
  const rows = await db
    .select({ verb: activity.verb })
    .from(activity)
    .where(
      or(
        eq(activity.objectEntityId, documentId),
        eq(activity.subjectEntityId, documentId),
      ),
    )
  return rows.map((r) => r.verb)
}

async function programs() {
  return import('#/lib/documents/refile')
}

describe('a document filed in N places', () => {
  it('shows on both Files tabs from one blob, and loses one edge at a time', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { storage } = await import('#/lib/storage')
    const { fileDocumentProgram, unfileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const dealId = await aDeal(tag)
    const deckId = await aFiledDeck(tag, companyId)

    // One blob, one row, two edges — never a copy (§3.4).
    await Effect.runPromise(
      fileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'record', entityId: dealId },
      }),
    )
    expect(await filesTabsShowing(deckId)).toEqual([companyId, dealId].sort())

    const sha = (
      await db
        .select({ sha: document.blobSha })
        .from(document)
        .where(eq(document.entityId, deckId))
    ).at(0)?.sha
    expect(sha).toBeTruthy()
    expect(
      await db
        .select({ id: document.entityId })
        .from(document)
        .where(eq(document.blobSha, sha ?? '')),
    ).toHaveLength(1)

    // Unfiling the deal leaves the company's row untouched.
    await Effect.runPromise(
      unfileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'record', entityId: dealId },
      }),
    )
    expect(await filesTabsShowing(deckId)).toEqual([companyId])

    // And the last edge: legal, and not a delete.
    await Effect.runPromise(
      unfileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'record', entityId: companyId },
      }),
    )
    expect(await filesTabsShowing(deckId)).toEqual([])
    expect(await spacesHolding(deckId)).toEqual([])

    const row = (
      await db
        .select({
          sha: document.blobSha,
          filename: document.filename,
          text: document.extractedText,
        })
        .from(document)
        .where(eq(document.entityId, deckId))
    ).at(0)
    expect(row?.filename).toBe(`deck-${tag}.pdf`)
    expect(await storage().exists(row?.sha ?? '')).toBe(true)
  })

  it('files into a space through entity_space, never through link', async () => {
    const { fileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const deckId = await aFiledDeck(tag, companyId)
    const spaceId = await aSpace(tag)

    await Effect.runPromise(
      fileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'space', entityId: spaceId },
      }),
    )
    expect(await spacesHolding(deckId)).toEqual([spaceId])
    expect(await filesTabsShowing(deckId)).toEqual([companyId])
  })

  it('is idempotent on both edge kinds, and writes no second activity row', async () => {
    const { fileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const dealId = await aDeal(tag)
    const deckId = await aFiledDeck(tag, companyId)
    const spaceId = await aSpace(tag)

    const file = (target: { kind: 'record' | 'space'; entityId: string }) =>
      Effect.runPromise(fileDocumentProgram(me, { documentId: deckId, target }))

    expect(await file({ kind: 'record', entityId: dealId })).toEqual({
      filed: true,
    })
    expect(await file({ kind: 'record', entityId: dealId })).toEqual({
      filed: false,
    })
    expect(await file({ kind: 'space', entityId: spaceId })).toEqual({
      filed: true,
    })
    expect(await file({ kind: 'space', entityId: spaceId })).toEqual({
      filed: false,
    })

    expect(await filesTabsShowing(deckId)).toEqual([companyId, dealId].sort())
    expect(await spacesHolding(deckId)).toEqual([spaceId])
    expect(
      (await verbsOn(deckId)).filter((v) => v === 'document.refiled'),
    ).toHaveLength(2)
  })

  it('refuses a merged-away target, a space as a record, and a document', async () => {
    const { db } = await import('@spaces/db')
    const { entity } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { fileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const deckId = await aFiledDeck(tag, companyId)
    const loserId = await aCompany(`${tag}-loser`)
    await db
      .update(entity)
      .set({ mergedIntoId: companyId })
      .where(eq(entity.id, loserId))
    const spaceId = await aSpace(tag)

    await expect(
      Effect.runPromise(
        fileDocumentProgram(me, {
          documentId: deckId,
          target: { kind: 'record', entityId: loserId },
        }),
      ),
    ).rejects.toThrow()

    // The union's own refusals, shared with the upload path.
    await expect(
      Effect.runPromise(
        fileDocumentProgram(me, {
          documentId: deckId,
          target: { kind: 'record', entityId: spaceId },
        }),
      ),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        fileDocumentProgram(me, {
          documentId: deckId,
          target: { kind: 'space', entityId: companyId },
        }),
      ),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        fileDocumentProgram(me, {
          documentId: deckId,
          target: { kind: 'record', entityId: deckId },
        }),
      ),
    ).rejects.toThrow()

    expect(await filesTabsShowing(deckId)).toEqual([companyId])
  })

  it('writes document.refiled on the target for both directions', async () => {
    const { db } = await import('@spaces/db')
    const { activity } = await import('@spaces/db/schema/activity')
    const { and, asc, eq } = await import('drizzle-orm')
    const { fileDocumentProgram, unfileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const dealId = await aDeal(tag)
    const deckId = await aFiledDeck(tag, companyId)

    await Effect.runPromise(
      fileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'record', entityId: dealId },
      }),
    )
    await Effect.runPromise(
      unfileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'record', entityId: dealId },
      }),
    )

    const rows = await db
      .select({ subject: activity.subjectEntityId, meta: activity.meta })
      .from(activity)
      .where(
        and(
          eq(activity.objectEntityId, deckId),
          eq(activity.verb, 'document.refiled'),
        ),
      )
      .orderBy(asc(activity.at))
    expect(rows.map((r) => r.subject)).toEqual([dealId, dealId])
    expect(rows.map((r) => r.meta)).toEqual([
      { action: 'filed', target: 'record' },
      { action: 'unfiled', target: 'record' },
    ])
  })

  it('answers unfiled:false for an edge that was never there', async () => {
    const { unfileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const otherId = await aCompany(`${tag}-other`)
    const deckId = await aFiledDeck(tag, companyId)

    expect(
      await Effect.runPromise(
        unfileDocumentProgram(me, {
          documentId: deckId,
          target: { kind: 'record', entityId: otherId },
        }),
      ),
    ).toEqual({ unfiled: false })
    expect(await filesTabsShowing(deckId)).toEqual([companyId])
  })
})

describe('the edges the Files tab renders', () => {
  it('names both kinds, with the object slug a custom record routes by', async () => {
    const { documentFilingEdges } = await import('#/lib/server/shared')
    const { fileDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const companyId = await aCompany(tag)
    const deckId = await aFiledDeck(tag, companyId)
    const spaceId = await aSpace(tag)
    await Effect.runPromise(
      fileDocumentProgram(me, {
        documentId: deckId,
        target: { kind: 'space', entityId: spaceId },
      }),
    )

    const edges = (await documentFilingEdges([deckId])).get(deckId) ?? []
    expect(edges).toContainEqual({
      kind: 'record',
      id: companyId,
      name: `Ohmium ${tag}`,
      entityKind: 'company',
      objectSlug: null,
    })
    expect(edges).toContainEqual({
      kind: 'space',
      id: spaceId,
      name: `Hydrogen ${tag}`,
    })
  })
})

describe('kind and re-extraction', () => {
  it('changes the kind once and calls a second identical set a non-event', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { setDocumentKindProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const deckId = await aFiledDeck(tag, await aCompany(tag))

    expect(
      await Effect.runPromise(
        setDocumentKindProgram(me, { documentId: deckId, kind: 'dd' }),
      ),
    ).toEqual({ kind: 'dd', changed: true })
    expect(
      await Effect.runPromise(
        setDocumentKindProgram(me, { documentId: deckId, kind: 'dd' }),
      ),
    ).toEqual({ kind: 'dd', changed: false })

    expect(
      (
        await db
          .select({ kind: document.kind })
          .from(document)
          .where(eq(document.entityId, deckId))
      ).at(0)?.kind,
    ).toBe('dd')
    expect(
      (await verbsOn(deckId)).filter((v) => v === 'document.kind_changed'),
    ).toHaveLength(1)
  })

  it('sends extraction back to pending and clears the error', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { reExtractDocumentProgram } = await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()

    const deckId = await aFiledDeck(tag, await aCompany(tag))
    await db
      .update(document)
      .set({
        extractionStatus: 'failed',
        extractionError: 'pdf-parse threw',
        extractedAt: new Date(),
      })
      .where(eq(document.entityId, deckId))

    await Effect.runPromise(reExtractDocumentProgram(me, deckId))

    const row = (
      await db
        .select({
          status: document.extractionStatus,
          error: document.extractionError,
        })
        .from(document)
        .where(eq(document.entityId, deckId))
    ).at(0)
    expect(row?.status).toBe('pending')
    expect(row?.error).toBe(null)
    expect(await verbsOn(deckId)).toContain('document.reextract_requested')
  })

  it('refuses an id that is not a document', async () => {
    const { reExtractDocumentProgram, setDocumentKindProgram } =
      await programs()
    const tag = randomUUID().slice(0, 8)
    const me = await actorId()
    const companyId = await aCompany(tag)

    await expect(
      Effect.runPromise(reExtractDocumentProgram(me, companyId)),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(
        setDocumentKindProgram(me, { documentId: companyId, kind: 'dd' }),
      ),
    ).rejects.toThrow()
  })
})
