import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fileAgainstForNote,
  isFileDrag,
  noteDropFailure,
  noteDropFiledIn,
  noteDropInsertPos,
  NOTE_DROP_LABEL,
  UNFILED_NOTE_MESSAGE,
} from './note-drop'

/**
 * §3.1 entry point 4, as far as a node-environment suite can take it
 * (SPA-140). The gesture is DOM and the editor is a `.tsx`, so what is
 * asserted here is the **value** that leaves the drop and what the writer
 * does with it: `fileAgainstForNote` → `birthDocumentProgram`, which is
 * exactly the path `uploadDocument` takes through `finalizeDocumentUpload`
 * (the server fn hands `data.fileAgainst` straight to the same program).
 *
 * The one claim that cannot be checked here is that the chip lands at the
 * pointer rather than at the end — `posAtCoords` needs a laid-out document.
 * What can be checked is the half that goes wrong silently: the position
 * captured before the `await` is re-validated against the document as it is
 * after it.
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

async function aSpace(name: string): Promise<{ id: string; name: string }> {
  const { createSpaceRow } = await import('#/lib/server/shared')
  return { id: await createSpaceRow(name, null, await actorId()), name }
}

/** A digest, which is all the browser lane ever hands the server. */
function aSha(tag: string): string {
  return createHash('sha256').update(`dropped ${tag}\n`, 'utf8').digest('hex')
}

/**
 * One file dropped on a note body, as the page makes it: the note's spaces
 * become one `fileAgainst` array, and that array is the whole input — one
 * call, however many spaces.
 */
async function dropOnNote(
  spaces: ReadonlyArray<{ id: string; name: string }>,
  sha: string,
): Promise<{ id: string; deduped: boolean }> {
  const { Effect } = await import('effect')
  const { birthDocumentProgram } = await import('./birth')
  return Effect.runPromise(
    birthDocumentProgram({
      blobSha: sha,
      filename: 'dropped.pdf',
      mime: 'application/pdf',
      sizeBytes: 4096,
      kind: 'deck',
      sourceClass: 'manual',
      sourceRef: null,
      provenance: {},
      fileAgainst: fileAgainstForNote(spaces),
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
  return {
    links: links.map((r) => r.to).sort(),
    spaces: spaces.map((r) => r.space).sort(),
  }
}

describe('a file dropped on a note body', () => {
  it('files ONE document row into every space the note is filed in', async () => {
    const hydrogen = await aSpace('Hydrogen (note drop)')
    const climate = await aSpace('Climate (note drop)')

    const born = await dropOnNote([hydrogen, climate], aSha('two spaces'))

    // One row, two edges — §3.4's "filed in N places without copying", and
    // the reason birth takes an array of targets rather than one.
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { eq } = await import('drizzle-orm')
    const rows = await db
      .select({ id: document.entityId })
      .from(document)
      .where(eq(document.blobSha, aSha('two spaces')))
    expect(rows.map((r) => r.id)).toEqual([born.id])

    // `entity_space` for both, and **no** `link(tagged_in)` at all: a note's
    // filing is entity_space only, so there is nothing for a record edge to
    // have come from (SPA-19's union).
    expect(await edgesOf(born.id)).toEqual({
      links: [],
      spaces: [hydrogen.id, climate.id].sort(),
    })
  })

  it('files nowhere, and says so, when the note is in no space', async () => {
    const born = await dropOnNote([], aSha('unfiled'))

    expect(fileAgainstForNote([])).toEqual([])
    expect(await edgesOf(born.id)).toEqual({ links: [], spaces: [] })

    // The document is unfiled by the only definition there is — no edge of
    // either kind — so `unfiledPredicate` must agree with the toast.
    const { db } = await import('@spaces/db')
    const { document } = await import('@spaces/db/schema')
    const { and, eq } = await import('drizzle-orm')
    const { unfiledPredicate } = await import('./unfiled')
    const unfiled = await db
      .select({ id: document.entityId })
      .from(document)
      .where(and(eq(document.entityId, born.id), unfiledPredicate()))
    expect(unfiled.map((r) => r.id)).toEqual([born.id])

    expect(noteDropFiledIn([])).toBe(UNFILED_NOTE_MESSAGE)
  })

  it('cannot file the same space twice however the note lists it', () => {
    // A duplicate would be a second `entity_space` row the writer refuses
    // rather than shrugs at, and the note's chip row is not the only place
    // the list comes from.
    const space = { id: '11111111-1111-4111-8111-111111111111', name: 'One' }
    expect(fileAgainstForNote([space, space])).toEqual([
      { kind: 'space', entityId: space.id },
    ])
    expect(noteDropFiledIn([space, space])).toBe('Filed in One')
  })

  it('names the spaces it filed into, in order', () => {
    expect(
      noteDropFiledIn([
        { id: 'a', name: 'Hydrogen' },
        { id: 'b', name: 'Climate' },
      ]),
    ).toBe('Filed in Hydrogen, Climate')
  })
})

describe('the drop position, re-validated after the upload', () => {
  /**
   * The stale-closure trap, as a number. The coordinate is resolved at drop
   * time because the pointer is gone by the time a PUT has finished — and a
   * document that shrank while it was in flight makes that number point at
   * nothing. `null` out means "insert at the cursor", which is what keeps a
   * successful upload from ever producing no chip.
   */
  it('keeps a position the document still has', () => {
    expect(noteDropInsertPos(12, 40)).toBe(12)
    expect(noteDropInsertPos(0, 40)).toBe(0)
    expect(noteDropInsertPos(40, 40)).toBe(40)
  })

  it('drops a position the document no longer has', () => {
    // Typed, then undone past the drop point while the PUT was in flight.
    expect(noteDropInsertPos(41, 40)).toBeNull()
    expect(noteDropInsertPos(-1, 40)).toBeNull()
    // An empty document: only position 0 survives, and a body deleted to
    // nothing has no interior at all.
    expect(noteDropInsertPos(5, 0)).toBeNull()
  })

  it('drops a coordinate that resolved to nothing', () => {
    // `posAtCoords` returns null when the pointer was over chrome rather
    // than over text — the gutter, the side menu, the affordance itself.
    expect(noteDropInsertPos(null, 40)).toBeNull()
    // A fractional position is not a ProseMirror position.
    expect(noteDropInsertPos(1.5, 40)).toBeNull()
  })
})

describe('what the drop takes over and what it leaves alone', () => {
  it('takes over a file drag and nothing else', () => {
    expect(isFileDrag(['Files'])).toBe(true)
    expect(isFileDrag(['Files', 'text/plain'])).toBe(true)
    // A BlockNote block dragged by its handle, and a plain text drag:
    // intercepting either would break the editor's own reordering.
    expect(isFileDrag(['blocknote/html', 'text/html'])).toBe(false)
    expect(isFileDrag([])).toBe(false)
  })

  it('names the file and the reason when nothing was inserted', () => {
    expect(
      noteDropFailure('deck.pdf', new Error('Larger than the limit')),
    ).toBe('deck.pdf: Larger than the limit')
    expect(noteDropFailure('deck.pdf', 'nope')).toBe('deck.pdf: Upload failed')
  })

  it('captions the affordance so it is not just the selection wash', () => {
    expect(NOTE_DROP_LABEL).toBe('Drop to file into this note')
  })
})
