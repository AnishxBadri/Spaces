import { Effect, Exit } from 'effect'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '@spaces/db'
import { company, document, entity, link } from '@spaces/db/schema'
import { user } from '@spaces/db/schema/auth'
import { FIXTURE_ACTOR } from '../../../vitest.seed'
import { DocumentDeleteRefused, deleteDocumentProgram } from './delete'
import { unfileDocumentProgram } from './refile'
import { listDocumentsProgram } from './shelf'
import { recordTimelineProgram } from '#/lib/timeline/record'

// The test databases carry no `pgboss` schema; unfiling enqueues a restamp.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * Unfile and delete, a file's two ways out, against the test database:
 * - a reader who cannot read a file cannot delete it;
 * - unfiling the last filing keeps the document, Unfiled;
 * - a delete leaves a History line on the record it was filed under.
 */

const ME = { id: FIXTURE_ACTOR.id }
const TEAMMATE = {
  id: 'member-teammate-delete',
  name: 'Priya',
  email: 'priya-delete@fund.example',
  emailVerified: true,
}

beforeAll(async () => {
  await db.insert(user).values(TEAMMATE).onConflictDoNothing()
})

async function aCompany(name: string): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'company', canonicalName: name })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no company')
  await db.insert(company).values({ entityId: ent.id })
  return ent.id
}

/** A document filed on `companyId`, private to `privateTo` when given. */
async function aFiledFile(
  filename: string,
  companyId: string,
  privateTo: string | null = null,
): Promise<string> {
  const ent = (
    await db
      .insert(entity)
      .values({ kind: 'document', canonicalName: filename })
      .returning({ id: entity.id })
  ).at(0)
  if (!ent) throw new Error('no document')
  await db.insert(document).values({
    entityId: ent.id,
    filename,
    kind: 'deck',
    ...(privateTo === null
      ? {}
      : { visibility: 'private' as const, authorId: privateTo }),
  })
  await db.insert(link).values({
    fromEntityId: ent.id,
    toEntityId: companyId,
    relation: 'tagged_in',
  })
  return ent.id
}

const stillThere = async (id: string) =>
  (
    await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.entityId, id))
  ).length === 1

describe('unfile and delete', () => {
  it('refuses a reader who cannot read the file, and leaves it whole', async () => {
    const flent = await aCompany('Flent')
    const id = await aFiledFile('Priya’s notes.pdf', flent, TEAMMATE.id)

    const exit = await Effect.runPromiseExit(deleteDocumentProgram(ME.id, id))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(String(exit.cause)).toContain(DocumentDeleteRefused.name)
    expect(await stillThere(id)).toBe(true)

    // Its author can.
    await Effect.runPromise(deleteDocumentProgram(TEAMMATE.id, id))
    expect(await stillThere(id)).toBe(false)
  })

  it('keeps the document when its last filing is unfiled, as Unfiled', async () => {
    const flent = await aCompany('Flent Unfile')
    const id = await aFiledFile('Term sheet v2.docx', flent)

    await Effect.runPromise(
      unfileDocumentProgram(ME.id, {
        documentId: id,
        target: { kind: 'record', entityId: flent },
      }),
    )

    expect(await stillThere(id)).toBe(true)
    const unfiled = await Effect.runPromise(
      listDocumentsProgram({ filed: 'unfiled', viewer: ME }),
    )
    expect(unfiled.map((d) => d.id)).toContain(id)
  })

  it('writes the delete on the record’s History, and the line outlives the file', async () => {
    const flent = await aCompany('Flent History')
    const id = await aFiledFile('Flent — Series A deck.pdf', flent)

    await Effect.runPromise(deleteDocumentProgram(ME.id, id))

    expect(await stillThere(id)).toBe(false)
    const items = await Effect.runPromise(recordTimelineProgram(flent, ME))
    const line = items.find(
      (i) => i.type === 'macro' && i.verb === 'document.deleted',
    )
    expect(line).toMatchObject({
      type: 'macro',
      actorName: FIXTURE_ACTOR.name,
      facts: { document: 'Flent — Series A deck.pdf' },
    })
  })
})
