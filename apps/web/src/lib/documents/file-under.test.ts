import { describe, expect, it, vi } from 'vitest'

// A filing may enqueue a restamp or an export; the test databases carry no
// `pgboss` schema.
vi.mock('#/lib/queue', () => import('#/test/queue-stub'))

/**
 * The `File under…` popover against the test database: its ticks write
 * through the real filing programs (the server fns' request is all that is
 * stood in), and `Named in the file` reads the file's stored text.
 * Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at
 * import time and the vitest setup rewrites it per file.
 */

const viewer = vi.hoisted(() => ({ id: '', email: 'reader@fund.example' }))

type Filing = {
  data: {
    documentId: string
    target: { kind: 'record' | 'space'; entityId: string }
  }
}

vi.mock('#/lib/server-fns', () => ({
  fileDocument: async ({ data }: Filing) => {
    const { Effect } = await import('effect')
    const { fileByHandProgram } = await import('./keep-copy')
    const { MailAttachments } = await import('#/lib/arrival/mail-attachments')
    return Effect.runPromise(
      fileByHandProgram(viewer.id, data).pipe(
        Effect.provide(MailAttachments.layer),
      ),
    )
  },
  unfileDocument: async ({ data }: Filing) => {
    const { Effect } = await import('effect')
    const { unfileDocumentProgram } = await import('./refile')
    return Effect.runPromise(unfileDocumentProgram(viewer.id, data))
  },
}))

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function aRecord(
  kind: 'company' | 'person' | 'deal',
  name: string,
  archived = false,
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { company, entity } = await import('@spaces/db/schema')
  const [row] = await db
    .insert(entity)
    .values({
      kind,
      canonicalName: name,
      ...(archived ? { archivedAt: new Date() } : {}),
    })
    .returning({ id: entity.id })
  if (kind === 'company') await db.insert(company).values({ entityId: row.id })
  return row.id
}

async function aFile(
  name: string,
  text: ReadonlyArray<string>,
  visibility: 'shared' | 'private' = 'shared',
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { chunk, document, entity } = await import('@spaces/db/schema')
  const author = await actorId()
  const [row] = await db
    .insert(entity)
    .values({ kind: 'document', canonicalName: name })
    .returning({ id: entity.id })
  await db.insert(document).values({
    entityId: row.id,
    filename: name,
    uploadedBy: author,
    authorId: author,
    visibility,
    extractionStatus: 'done',
  })
  if (text.length > 0)
    await db.insert(chunk).values(
      text.map((t, idx) => ({
        entityId: row.id,
        sourceKind: 'document' as const,
        idx,
        text: t,
        page: idx + 1,
      })),
    )
  return row.id
}

async function unfiledIds(): Promise<Array<string>> {
  const { db } = await import('@spaces/db')
  const { document } = await import('@spaces/db/schema')
  const { unfiledPredicate } = await import('./unfiled')
  const rows = await db
    .select({ id: document.entityId })
    .from(document)
    .where(unfiledPredicate())
  return rows.map((r) => r.id)
}

async function options(documentId: string, q = '') {
  const { Effect } = await import('effect')
  const { fileUnderOptionsProgram } = await import('./file-under')
  return Effect.runPromise(fileUnderOptionsProgram(viewer, documentId, q))
}

describe('the File under popover’s ticks', () => {
  it('files on a tick and unfiles on an untick; the last untick leaves the file Unfiled, not deleted', async () => {
    viewer.id = await actorId()
    const { createSpaceRow } = await import('#/lib/server/shared')
    const { setFiled } = await import('./file-under-writes')
    const company = await aRecord('company', 'Brightline')
    const space = await createSpaceRow('Proptech', null, viewer.id)
    const file = await aFile('Brightline deck.pdf', [])
    expect(await unfiledIds()).toContain(file)

    let filed = await setFiled(
      file,
      { kind: 'record', entityId: company },
      true,
      [],
    )
    filed = await setFiled(
      file,
      { kind: 'space', entityId: space },
      true,
      filed,
    )
    expect(filed.sort()).toEqual([company, space].sort())
    expect((await options(file)).filed.sort()).toEqual([company, space].sort())
    expect(await unfiledIds()).not.toContain(file)
    // What the reader just filed under comes back as Recent, ticked.
    const recent = (await options(file)).bands.find((b) => b.label === 'Recent')
    expect(recent?.options.map((o) => o.target.entityId)).toEqual(
      expect.arrayContaining([company, space]),
    )

    // A tick on what is already filed is the same outcome, not an error.
    await setFiled(file, { kind: 'space', entityId: space }, true, filed)

    filed = await setFiled(
      file,
      { kind: 'record', entityId: company },
      false,
      filed,
    )
    expect((await options(file)).filed).toEqual([space])
    expect(await unfiledIds()).not.toContain(file)

    filed = await setFiled(
      file,
      { kind: 'space', entityId: space },
      false,
      filed,
    )
    expect(filed).toEqual([])
    expect((await options(file)).filed).toEqual([])
    expect(await unfiledIds()).toContain(file)
  })
})

describe('Named in the file', () => {
  it('offers the live records the text names, by whole word, in the order it names them, and nothing to a reader who may not read it', async () => {
    viewer.id = await actorId()
    const { Effect } = await import('effect')
    const { namedInFileProgram } = await import('./file-under')
    const exponent = await aRecord('company', 'Exponent')
    const round = await aRecord('deal', 'Exponent Series A')
    const priya = await aRecord('person', 'Priya Raman')
    await aRecord('company', 'Flent')
    await aRecord('company', 'Exponential Labs')
    await aRecord('company', 'Gone Co', true)
    await aRecord('company', 'AI')
    const file = await aFile('deck.pdf', [
      'Priya Raman, CEO. Exponent is raising its Exponent Series A.',
      'Growth is exponential. Gone Co was acquired. AI everywhere.',
    ])

    const named = await Effect.runPromise(namedInFileProgram(viewer, file))
    // Companies, then deals, then people; never a word inside a word, an
    // archived record or a name under three characters.
    expect(named.map((o) => o.target.entityId)).toEqual([
      exponent,
      round,
      priya,
    ])
    expect(named.at(0)).toMatchObject({
      name: 'Exponent',
      kind: 'company',
      target: { kind: 'record' },
    })

    const bands = (await options(file)).bands
    expect(bands.at(0)?.label).toBe('Named in the file')

    // Capped, and silent for a private file of someone else's.
    expect(
      await Effect.runPromise(namedInFileProgram(viewer, file, 1)),
    ).toHaveLength(1)
    const secret = await aFile('their deck.pdf', ['Exponent again'], 'private')
    expect(
      await Effect.runPromise(
        namedInFileProgram({ id: 'someone-else' }, secret),
      ),
    ).toEqual([])
  })
})
