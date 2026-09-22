import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileAgainstFor, filingNote, uploadTarget } from './file-against'
import type { FilingMode, PickedEntity } from './file-against'

/**
 * The global upload dialog's file-against control, end to end (SPA-108).
 *
 * The dialog is a `.tsx` and the suite runs on `environment: 'node'`, so what
 * is asserted here is the **value** that leaves the control and what the
 * writer does with it — `uploadTarget` → `fileAgainstFor` →
 * `birthDocumentProgram`, which is exactly the path `uploadDocument` takes
 * through `finalizeDocumentUpload` (the server fn hands `data.fileAgainst`
 * straight to the same program). The three states of the control are the
 * three cases §3.1 entry point 3 names, and this file runs all three against
 * a real database in one test so a fourth state cannot be added without one.
 *
 * The queue is stubbed the way every document fixture file stubs it —
 * `enqueue` is the one side effect birth has outside the transaction.
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
  expect(actor).toBeTruthy()
  return actor.id
}

async function aCompany(name: string): Promise<PickedEntity> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [ent] = await db
    .insert(entity)
    .values({ kind: 'company', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(company).values({ entityId: ent.id })
  return { entityId: ent.id, name }
}

async function aSpace(name: string): Promise<PickedEntity> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return { entityId: await createSpaceRow(name, null, await actorId()), name }
}

/** A digest, which is all the browser lane ever hands the server. */
function aSha(tag: string): string {
  return createHash('sha256').update(`deck ${tag}\n`, 'utf8').digest('hex')
}

/**
 * One drop, as the dialog makes it: the control's two pieces of state become
 * a target, the target becomes `fileAgainst`, and the rest of the input is
 * what `finalizeDocumentUpload` fills in for a person dropping a file on a
 * surface we ship.
 */
async function drop(
  mode: FilingMode,
  picked: PickedEntity | null,
  sha: string,
): Promise<{ id: string; deduped: boolean }> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('./birth')
  const target = uploadTarget(mode, picked)
  expect(target).not.toBeNull()
  if (target === null) throw new Error('unreachable')
  return Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename: `${mode}.pdf`,
      mime: 'application/pdf',
      sizeBytes: 2048,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: fileAgainstFor(target),
      actor: { userId: await actorId() },
    }),
  )
}

async function edgesOf(
  documentId: string,
): Promise<{ links: Array<string>; spaces: Array<string> }> {
  const { db } = await import('@spaces/db')
  const { entitySpace, link } = await import('@spaces/db/schema')
  const { eq } = await import('drizzle-orm')
  const links = await db
    .select({ to: link.toEntityId })
    .from(link)
    .where(eq(link.fromEntityId, documentId))
  const spaces = await db
    .select({ space: entitySpace.spaceId })
    .from(entitySpace)
    .where(eq(entitySpace.entityId, documentId))
  return { links: links.map((r) => r.to), spaces: spaces.map((r) => r.space) }
}

async function subjectOf(documentId: string): Promise<string | undefined> {
  const { db } = await import('@spaces/db')
  const { activity } = await import('@spaces/db/schema/activity')
  const { and, eq } = await import('drizzle-orm')
  const rows = await db
    .select({ subject: activity.subjectEntityId })
    .from(activity)
    .where(
      and(
        eq(activity.objectEntityId, documentId),
        eq(activity.verb, 'document.filed'),
      ),
    )
  return rows.at(0)?.subject
}

describe('the upload dialog’s three filing states', () => {
  it('files a record through link, a space through entity_space, and unfiled through neither', async () => {
    const company = await aCompany('Ohmium (upload dialog)')
    const space = await aSpace('Hydrogen (upload dialog)')

    // A record: `link(tagged_in)`, no entity_space row, and the activity
    // line reads on that record's timeline.
    const onRecord = await drop('record', company, aSha('record'))
    expect(await edgesOf(onRecord.id)).toEqual({
      links: [company.entityId],
      spaces: [],
    })
    expect(await subjectOf(onRecord.id)).toBe(company.entityId)

    // A space: `entity_space`, never a link — SPA-19's union is what stops a
    // space being a link target again.
    const inSpace = await drop('space', space, aSha('space'))
    expect(await edgesOf(inSpace.id)).toEqual({
      links: [],
      spaces: [space.entityId],
    })
    expect(await subjectOf(inSpace.id)).toBe(space.entityId)

    // Unfiled: neither table, and the activity row's subject is the document
    // itself — `activity.subject_entity_id` is NOT NULL and there is no
    // target to stand in for it.
    const unfiled = await drop('unfiled', null, aSha('unfiled'))
    expect(await edgesOf(unfiled.id)).toEqual({ links: [], spaces: [] })
    expect(await subjectOf(unfiled.id)).toBe(unfiled.id)
  })

  it('does not dedupe the same sha dropped twice unfiled — two rows, one blob', async () => {
    // §3.4's rule is "the same bytes already filed *here*", and an unfiled
    // drop has no here. Two copies of one deck in the inbox are two rows to
    // file, not one row nobody filed twice.
    const sha = aSha('twice')
    const first = await drop('unfiled', null, sha)
    const second = await drop('unfiled', null, sha)

    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(false)
    expect(second.id).not.toBe(first.id)

    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select({ id: document.entityId, sha: document.blobSha })
      .from(document)
      .where(eq(document.blobSha, sha))
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort())
    // One blob under both: the dedupe that does apply is storage's, by
    // content address, and it happened before either row existed.
    expect(new Set(rows.map((r) => r.sha)).size).toBe(1)
  })

  it('refuses to guess when a mechanism is chosen and nothing is picked', () => {
    // The one outcome the dialog must not produce: "a record, but none
    // picked" filed as unfiled. The drop zone reads this null and disarms.
    expect(uploadTarget('record', null)).toBeNull()
    expect(uploadTarget('space', null)).toBeNull()
    expect(filingNote(null)).toBe('choose one first')

    // Unfiled needs no pick — it is an answer, not a missing one.
    expect(uploadTarget('unfiled', null)).toEqual({ kind: 'unfiled' })
    expect(fileAgainstFor({ kind: 'unfiled' })).toEqual([])
  })
})
