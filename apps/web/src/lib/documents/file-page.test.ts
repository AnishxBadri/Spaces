import { isNotFound } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import { openFileWindowOf } from '#/lib/modal-search'
import { recordSearch } from '#/lib/records/record-tabs'

/**
 * A file's address: `?modal=file&id=` (with `&page=`) opens its window over
 * any page, and `/files/<id>` loads its page or the not-found page. The
 * loader runs the real `fileViewProgram` against the test database, as the
 * reader the test names; only the request around the server fn is stood in.
 * Dynamic imports: `@spaces/db` builds its pool from `DATABASE_URL` at import
 * time and the vitest setup rewrites it per file.
 */

const viewer = vi.hoisted(() => ({ id: '', email: 'reader@fund.example' }))

vi.mock('#/lib/server-fns', () => ({
  getFileView: async ({ data }: { data: { id: string } }) => {
    const { Effect } = await import('effect')
    const { fileViewProgram } = await import('./file-view')
    return Effect.runPromise(fileViewProgram(viewer, data.id))
  },
}))

const FILE = '0b6ad7a2-6a3e-4c4f-9a43-5d1f1d8b6c11'

/** Another member: the read gate compares ids, so any id stands in. */
const OTHER = 'someone-else'

async function actorId(): Promise<string> {
  const { db } = await import('@spaces/db')
  const { user } = await import('@spaces/db/schema/auth')
  const [actor] = await db.select({ id: user.id }).from(user).limit(1)
  return actor.id
}

async function aFile(
  name: string,
  author: string,
  visibility: 'shared' | 'private',
): Promise<string> {
  const { db } = await import('@spaces/db')
  const { document, entity } = await import('@spaces/db/schema')
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
  })
  return row.id
}

describe('the file window address', () => {
  it('opens from the search params over any page, at the page asked for', () => {
    expect(openFileWindowOf({ modal: 'file', id: FILE })).toEqual({
      id: FILE,
      page: null,
    })
    expect(
      openFileWindowOf({ tab: 'files', modal: 'file', id: FILE, page: 3 }),
    ).toEqual({ id: FILE, page: 3 })
    // A bad page is ignored, not a reason to refuse the window.
    expect(openFileWindowOf({ modal: 'file', id: FILE, page: 0 })).toEqual({
      id: FILE,
      page: null,
    })
    expect(openFileWindowOf({ modal: 'note', id: FILE })).toBeNull()
    expect(openFileWindowOf({ modal: 'file', id: 'not-a-uuid' })).toBeNull()
    expect(openFileWindowOf({ modal: 'file' })).toBeNull()
  })

  it('keeps the window over a record and opens it on the Files tab', async () => {
    const { linkedRecordTab } = await import('#/lib/records/record-tabs')
    const search = recordSearch.parse({ modal: 'file', id: FILE, page: 2 })
    expect(search).toMatchObject({ modal: 'file', id: FILE, page: 2 })
    expect(linkedRecordTab(search)).toBe('files')
  })
})

describe('loadFilePage', () => {
  it('loads a file the reader may read', async () => {
    const author = await actorId()
    const id = await aFile('deck.pdf', author, 'shared')
    viewer.id = author
    const { loadFilePage } = await import('./file-page')
    const view = await loadFilePage(id)
    expect(view.doc).toMatchObject({ id, filename: 'deck.pdf' })
    // The reader's own upload names nobody.
    expect(view.origin).toMatchObject({ via: 'upload', by: null })
  })

  it('refuses a file the reader may not read, one that is not there and a bad id', async () => {
    const author = await actorId()
    const id = await aFile('private memo.pdf', author, 'private')
    const { loadFilePage } = await import('./file-page')

    viewer.id = OTHER
    const refused = await loadFilePage(id).then(
      () => null,
      (err: unknown) => err,
    )
    expect(isNotFound(refused)).toBe(true)

    for (const missing of [FILE, 'not-a-uuid']) {
      const gone = await loadFilePage(missing).then(
        () => null,
        (err: unknown) => err,
      )
      expect(isNotFound(gone)).toBe(true)
    }

    viewer.id = author
    await expect(loadFilePage(id)).resolves.toMatchObject({ doc: { id } })
  })
})
