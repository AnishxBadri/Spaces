import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

// The test databases carry no `pgboss` schema, and the birth of a document
// enqueues extraction — see `#/test/queue-stub`.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * `interaction.source` and `document.origin` as `source_class` + `source_ref`
 * (SPA-137) — the last two vendor-named enums, against the test database.
 *
 * The two write sites are one literal each, and both literals are `manual`:
 * a person logging a meeting and a person dropping a file on the Files tab
 * are the product's plainest manual writers. What is worth asserting is that
 * the pair they write survives the round trip and that the read side can tell
 * the two cases apart — a hand-uploaded deck must render no provenance
 * suffix, and a connector-filed one must name the integration rather than the
 * word "integration", exactly as the dedupe card does for an entity.
 *
 * The server fns themselves need a request context no test has, so these call
 * the helpers they delegate to (`server/shared.ts`, which the client barrel
 * does not re-export). The render is unproven without a browser; the string
 * the Files tab joins is `sourceCapability`, and that is what is checked here.
 *
 * Imports are dynamic like the rest of the DB-coupled suite: `@spaces/db`
 * builds its pool from `DATABASE_URL` at import time and `vitest.setup.ts`
 * rewrites it per file.
 */

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  expect(actor).toBeTruthy()
  return actor.id
}

/** A company to file things against. */
async function aRecord(tag: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: `Ohmium ${tag}` })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/**
 * The message of a refused write, constraint name included. Drizzle wraps the
 * driver's error and its own message is only the SQL it sent — the name of
 * the constraint that did the refusing is one `cause` down, and the name is
 * the whole point of asserting on it.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (err) {
    if (!(err instanceof Error)) return String(err)
    return `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`
  }
  throw new Error('The write was accepted; it should have been refused')
}

async function anIntegration(capabilityId: string): Promise<string> {
  const { db } = await import('@spaces/db')
  const { integration } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(integration)
    .values({ capabilityId, version: '1.0.0' })
    .returning({ id: integration.id })
  return row.id
}

describe('document provenance', () => {
  it('files an uploaded deck as manual, with nothing to say about a vendor', async () => {
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { documentProvenance } = await import('./shared')
    const { birthDocumentProgram } = await import('#/lib/documents/birth')
    const tag = randomUUID().slice(0, 8)

    const { id } = await Effect.runPromise(
      birthDocumentProgram({
        blobSha: 'b'.repeat(64),
        filename: `deck-${tag}.pdf`,
        mime: 'application/pdf',
        sizeBytes: 1024,
        kind: 'deck',
        sourceClass: 'manual',
        sourceRef: null,
        provenance: {},
        fileAgainst: [{ kind: 'record', entityId: await aRecord(tag) }],
        actor: { userId: await actorId() },
      }),
    )

    const row = (
      await db
        .select({
          sourceClass: document.sourceClass,
          sourceRef: document.sourceRef,
        })
        .from(document)
        .where(eq(document.entityId, id))
    ).at(0)
    expect(row?.sourceClass).toBe('manual')
    expect(row?.sourceRef).toBe(null)

    // What the Files tab reads: no capability, so the mono lane joins its
    // four existing parts and appends nothing.
    const p = await documentProvenance([id])
    expect(p.get(id)).toEqual({ sourceClass: 'manual', sourceCapability: null })
  })

  it('names the integration that filed a document, not the class', async () => {
    const { db } = await import('@spaces/db')
    const { document, entity } = await import('@spaces/db/schema')
    const { documentProvenance } = await import('./shared')
    const tag = randomUUID().slice(0, 8)

    const ref = await anIntegration(`gmail-${tag}`)
    const [ent] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `attachment-${tag}.pdf` })
      .returning({ id: entity.id })
    await db.insert(document).values({
      entityId: ent.id,
      filename: `attachment-${tag}.pdf`,
      kind: 'deck',
      sourceClass: 'integration',
      sourceRef: ref,
    })

    const p = await documentProvenance([ent.id])
    expect(p.get(ent.id)).toEqual({
      sourceClass: 'integration',
      sourceCapability: `gmail-${tag}`,
    })
  })

  it('refuses a document that claims an integration it cannot name', async () => {
    const { db } = await import('@spaces/db')
    const { document, entity } = await import('@spaces/db/schema')
    const tag = randomUUID().slice(0, 8)

    const [ent] = await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: `orphan-${tag}.pdf` })
      .returning({ id: entity.id })
    // The biconditional, from the app's side: `integration` without a ref is
    // a provenance hole, and the database is where that is settled.
    const refusal = await refusalOf(() =>
      db.insert(document).values({
        entityId: ent.id,
        filename: `orphan-${tag}.pdf`,
        sourceClass: 'integration',
      }),
    )
    expect(refusal).toMatch(/document_source_ref_invariant/)
  })
})

describe('interaction provenance', () => {
  it('logs a meeting as manual and puts it on the record timeline', async () => {
    const { db } = await import('@spaces/db')
    const { interaction } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const { logInteractionProgram } = await import('../interactions/log')
    const { recordTimelineProgram } = await import('../timeline/record')
    const tag = randomUUID().slice(0, 8)

    const recordId = await aRecord(tag)
    const { id } = await Effect.runPromise(
      logInteractionProgram(await actorId(), {
        kind: 'meeting',
        subject: `Site visit ${tag}`,
        occurredAt: new Date('2026-09-18T10:00:00Z'),
        attendeeIds: [recordId],
        writeUp: false,
      }),
    )

    const row = (
      await db
        .select({
          sourceClass: interaction.sourceClass,
          sourceRef: interaction.sourceRef,
        })
        .from(interaction)
        .where(eq(interaction.id, id))
    ).at(0)
    expect(row?.sourceClass).toBe('manual')
    expect(row?.sourceRef).toBe(null)

    const items = await Effect.runPromise(recordTimelineProgram(recordId))
    const logged = items.find((i) => i.type === 'interaction' && i.id === id)
    expect(logged).toBeTruthy()
    expect(logged).toMatchObject({
      kind: 'meeting',
      subject: `Site visit ${tag}`,
    })
  })

  it('refuses an interaction that claims an integration it cannot name', async () => {
    const { db } = await import('@spaces/db')
    const { interaction } = await import('@spaces/db/schema')

    const refusal = await refusalOf(() =>
      db.insert(interaction).values({
        kind: 'email',
        sourceClass: 'integration',
        occurredAt: new Date(),
      }),
    )
    expect(refusal).toMatch(/interaction_source_ref_invariant/)
  })
})
